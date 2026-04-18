import * as ts from 'typescript'

export type FitDomainPath = {
  root: string
  segments: FitDomainPathSegment[]
}

export type FitDomainPathSegment =
  | {kind: 'prop'; name: string}
  | {kind: 'item'}

export type ParsedFitExpression = {
  expression: ts.Expression
  domainPaths: Map<string, FitDomainPath>
}

export type FitSpec =
  | {
      kind: 'given-range'
      expression: string
      valueKind: 'int' | 'number'
      min: number
      max: number
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
      valueKind: 'int' | 'number'
      min: number
      max: number
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
const domainPathPattern = new RegExp(`${identifierPattern}(?:(?:\\.${identifierPattern})|(?:\\[\\]))+`, 'g')

export function parseFitSpecs(sourceText: string, node: ts.Node): FitSpec[] {
  const commentRanges = ts.getLeadingCommentRanges(sourceText, node.pos) ?? []
  const specs: FitSpec[] = []

  for (const range of commentRanges) {
    const comment = sourceText.slice(range.pos, range.end)
    const lines = comment.split(/\r?\n/).map(cleanCommentLine)
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

function cleanCommentLine(line: string) {
  return line
    .replace(/^\s*\/\*\*?/, '')
    .replace(/\*\/\s*$/, '')
    .replace(/^\s*\*\s?/, '')
    .trim()
}

const numberPattern = '-?\\d+(?:\\.\\d+)?'
const rangePattern = new RegExp(`^(?:(int)\\s+)?(${numberPattern})\\s*\\.\\.\\s*(${numberPattern})$`)

function parseFitSpecLine(line: string): FitSpec {
  const givenRange = /^given\s+(.+)\s*:\s*(.+)$/.exec(line)
  if (givenRange != null) {
    const expression = givenRange[1]!.trim()
    const range = parseRangeText(givenRange[2]!.trim())
    if (range == null) throw new Error(`Unsupported @fit range: ${line}`)
    parseExpression(expression)
    return {
      kind: 'given-range',
      expression,
      valueKind: range.valueKind,
      min: range.min,
      max: range.max,
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
      valueKind: range.valueKind,
      min: range.min,
      max: range.max,
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

function parseRangeText(text: string): {valueKind: 'int' | 'number'; min: number; max: number} | null {
  const range = rangePattern.exec(text)
  if (range == null) return null
  return {
    valueKind: range[1] == null ? 'number' : 'int',
    min: Number(range[2]!),
    max: Number(range[3]!),
  }
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
    if (!match.includes('[]')) return match
    const domainPath = parseDomainPathText(match)
    if (domainPath == null) return match
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
  const match = new RegExp(`^(${identifierPattern})((?:\\.${identifierPattern}|\\[\\])*)$`).exec(text)
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
    .replaceAll('[]', '.__item')
    .split('.')
    .filter(part => part.length > 0)
    .map(part => part.replace(/[^\w$]/g, '_'))
  return `__fit_domain_${parts.join('_')}`
}
