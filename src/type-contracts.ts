import * as ts from 'typescript'
import {
  fitBlockSpecCommentLines,
  fitCommentLineGroupsInRange,
  fitReturnPublicRoot,
  inlineFitCommentLinesForNode,
  parseFitSpecLine,
  publicFitText,
  type ComparisonOperator,
  type FitCheckSpec,
  type FitCommentLine,
  type FitGivenSpec,
} from './parser.ts'
import {type FitFunction} from './modules.ts'
import {type Program} from './check-types.ts'

type ContractKind = 'check' | 'given'
type TypeContractSpec = FitCheckSpec | FitGivenSpec

export type TypeContractUnsupported = {
  text: string
  reason: string
  line?: number
}

export type TypeContractResult<T extends TypeContractSpec> = {
  specs: T[]
  unsupported: TypeContractUnsupported[]
}

type TypeScope = {
  root: string
  requiredFields: Set<string>
  optionalFields: Set<string>
}

type TypeLineResult = {
  text: string
} | {
  unsupported: string
}

type TopLevelComparison = {
  left: string
  op: ComparisonOperator
  right: string
}

const identifierPattern = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g
const shorthandComparisonPattern = /^(==|>=|<=|>|<)\s*(.+)$/
const intRangePrefixPattern = /^(int\s+)([\s\S]+)$/

export function typeInputGivenContractForFunction(program: Program, fn: FitFunction): TypeContractResult<FitGivenSpec> {
  const results: TypeContractResult<FitGivenSpec>[] = []
  for (const param of fn.node.parameters) {
    if (!ts.isIdentifier(param.name)) continue
    results.push(typeGivenContractForTypeNode(program, param.type, param.name.text))
  }
  return dedupeResult(mergeResults(results))
}

export function typeReturnCheckContractForFunction(program: Program, fn: FitFunction): TypeContractResult<FitCheckSpec> {
  return typeCheckContractForTypeNode(program, fn.node.type, fitReturnPublicRoot)
}

export function typeCheckContractForTypeNode(program: Program, type: ts.TypeNode | undefined, root: string): TypeContractResult<FitCheckSpec> {
  return dedupeResult(collectTypeContractSpecs(program, type, root, 'check', new Set()) as TypeContractResult<FitCheckSpec>)
}

function typeGivenContractForTypeNode(program: Program, type: ts.TypeNode | undefined, root: string): TypeContractResult<FitGivenSpec> {
  return dedupeResult(collectTypeContractSpecs(program, type, root, 'given', new Set()) as TypeContractResult<FitGivenSpec>)
}

function collectTypeContractSpecs(
  program: Program,
  type: ts.TypeNode | undefined,
  root: string,
  kind: ContractKind,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  if (type == null) return emptyResult()

  if (ts.isParenthesizedTypeNode(type)) return collectTypeContractSpecs(program, type.type, root, kind, seen)
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return collectTypeContractSpecs(program, type.type, root, kind, seen)
  }
  if (ts.isArrayTypeNode(type)) return collectTypeContractSpecs(program, type.elementType, `${root}[]`, kind, seen)
  if (ts.isIntersectionTypeNode(type)) {
    return mergeResults(type.types.map(member => collectTypeContractSpecs(program, member, root, kind, seen)))
  }
  if (ts.isTypeLiteralNode(type)) return collectObjectMemberContractSpecs(program, type.members, root, kind, seen, [type])
  if (ts.isTypeReferenceNode(type)) return collectTypeReferenceContractSpecs(program, type, root, kind, seen)
  return emptyResult()
}

function collectTypeReferenceContractSpecs(
  program: Program,
  type: ts.TypeReferenceNode,
  root: string,
  kind: ContractKind,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : null
  const typeArgument = type.typeArguments?.[0]
  if ((name === 'Array' || name === 'ReadonlyArray') && typeArgument != null) {
    return collectTypeContractSpecs(program, typeArgument, `${root}[]`, kind, seen)
  }

  const declaration = localTypeDeclarationForReference(program, type)
  if (declaration == null) return parseUnsupportedAttachedSpecs(type.getSourceFile().text, type, 'type @fit supports source-backed type references')
  const key = `${declaration.getSourceFile().fileName}#${declaration.name?.text ?? declaration.pos}`
  if (seen.has(key)) return emptyResult()
  seen.add(key)

  const specs = ts.isInterfaceDeclaration(declaration)
    ? collectObjectMemberContractSpecs(program, declaration.members, root, kind, seen, [declaration])
    : collectTypeAliasContractSpecs(program, declaration, root, kind, seen)
  seen.delete(key)
  return declaration.getSourceFile() === program.sourceFile ? specs : relocateTypeContractLocations(specs, lineNumberForNode(type))
}

function collectTypeAliasContractSpecs(
  program: Program,
  declaration: ts.TypeAliasDeclaration,
  root: string,
  kind: ContractKind,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  if (ts.isTypeLiteralNode(declaration.type)) {
    return collectObjectMemberContractSpecs(program, declaration.type.members, root, kind, seen, [declaration, declaration.type])
  }
  return mergeResults([
    parseScalarTypeAttachedSpecs(declaration.getSourceFile().text, declaration, root, kind),
    collectTypeContractSpecs(program, declaration.type, root, kind, seen),
  ])
}

function collectObjectMemberContractSpecs(
  program: Program,
  members: ts.NodeArray<ts.TypeElement>,
  root: string,
  kind: ContractKind,
  seen: Set<string>,
  scopeNodes: ts.Node[],
): TypeContractResult<TypeContractSpec> {
  const sourceText = members.length > 0 ? members[0]!.getSourceFile().text : scopeNodes[0]?.getSourceFile().text ?? program.sourceText
  const scope = objectScope(root, members)
  const results: TypeContractResult<TypeContractSpec>[] = [
    ...scopeNodes.map(node => parseObjectScopeAttachedSpecs(sourceText, node, scope, kind)),
    ...scopeNodes.map(node => parseObjectBodyDetachedSpecs(sourceText, node, members, scope, kind)),
  ]

  for (const member of members) {
    if (!ts.isPropertySignature(member)) {
      results.push(parseUnsupportedAttachedSpecs(sourceText, member, 'type @fit supports property fields only'))
      continue
    }

    const attachedLines = typeAttachedCommentLines(sourceText, member)
    const name = propertyNameText(member.name)
    if (name == null) {
      if (attachedLines.length > 0) {
        results.push(unsupportedLines(attachedLines, 'type @fit supports identifier, string, and numeric property names'))
      }
      continue
    }

    if (member.questionToken != null) {
      if (attachedLines.length > 0) {
        results.push(unsupportedLines(attachedLines, 'type @fit on optional fields is not supported yet'))
      }
      continue
    }

    const propRoot = `${root}.${name}`
    results.push(parsePropertyAttachedSpecs(sourceText, member, propRoot, scope, kind))
    results.push(collectTypeContractSpecs(program, member.type, propRoot, kind, seen))
  }
  return mergeResults(results)
}

function parseScalarTypeAttachedSpecs(sourceText: string, node: ts.Node, root: string, kind: ContractKind): TypeContractResult<TypeContractSpec> {
  const fieldScope: TypeScope = {root, requiredFields: new Set(), optionalFields: new Set()}
  const lines = typeAttachedCommentLines(sourceText, node)
  return parseTypeCommentLines(lines, fieldScope, root, kind)
}

function parseObjectScopeAttachedSpecs(sourceText: string, node: ts.Node, scope: TypeScope, kind: ContractKind): TypeContractResult<TypeContractSpec> {
  return parseTypeCommentLines(typeAttachedCommentLines(sourceText, node), scope, null, kind)
}

function parseObjectBodyDetachedSpecs(
  sourceText: string,
  node: ts.Node,
  members: ts.NodeArray<ts.TypeElement>,
  scope: TypeScope,
  kind: ContractKind,
): TypeContractResult<TypeContractSpec> {
  const lines = objectBodyDetachedCommentLines(sourceText, node, members)
  return parseTypeCommentLines(lines, scope, null, kind)
}

function parsePropertyAttachedSpecs(
  sourceText: string,
  node: ts.Node,
  fieldRoot: string,
  scope: TypeScope,
  kind: ContractKind,
): TypeContractResult<TypeContractSpec> {
  return parseTypeCommentLines(typeAttachedCommentLines(sourceText, node), scope, fieldRoot, kind)
}

function parseTypeCommentLines(
  lines: FitCommentLine[],
  scope: TypeScope,
  fieldRoot: string | null,
  kind: ContractKind,
): TypeContractResult<TypeContractSpec> {
  const specs: TypeContractSpec[] = []
  const unsupported: TypeContractUnsupported[] = []
  for (const line of lines) {
    const body = typeCommentBody(line)
    if (body.length === 0) continue
    const parsed = typeLineText(body, scope, fieldRoot)
    if ('unsupported' in parsed) {
      unsupported.push({text: body, reason: parsed.unsupported, line: line.line})
      continue
    }
    const specLine = kind === 'given' ? `given ${parsed.text}` : parsed.text
    try {
      const spec = parseFitSpecLine(specLine, line.line)
      if (kind === 'given' && (spec.kind === 'given-range' || spec.kind === 'given-comparison')) {
        specs.push(spec)
      } else if (kind === 'check' && (spec.kind === 'check-range' || spec.kind === 'check-comparison')) {
        specs.push(spec)
      } else {
        unsupported.push({text: body, reason: 'type @fit supports ranges and comparisons only', line: line.line})
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      unsupported.push({text: body, reason, line: line.line})
    }
  }
  return {specs, unsupported}
}

function typeLineText(body: string, scope: TypeScope, fieldRoot: string | null): TypeLineResult {
  const shorthandComparison = shorthandComparisonPattern.exec(body)
  if (shorthandComparison != null) {
    if (fieldRoot == null) return {unsupported: 'type @fit shorthand needs a field to attach to'}
    const right = rewriteExpressionReferences(shorthandComparison[2]!.trim(), scope)
    if ('unsupported' in right) return right
    return {text: `${fieldRoot} ${shorthandComparison[1]!} ${right.text}`}
  }

  const range = splitTopLevelColon(body)
  if (range != null) {
    const expression = rewriteExpressionReferences(range.left, scope)
    if ('unsupported' in expression) return expression
    const rangeText = rewriteRangeReferences(range.right, scope)
    if ('unsupported' in rangeText) return rangeText
    return {text: `${expression.text}: ${rangeText.text}`}
  }

  const comparison = findTopLevelComparison(body)
  if (comparison != null) {
    const left = rewriteExpressionReferences(comparison.left, scope)
    if ('unsupported' in left) return left
    const right = rewriteExpressionReferences(comparison.right, scope)
    if ('unsupported' in right) return right
    return {text: `${left.text} ${comparison.op} ${right.text}`}
  }

  if (fieldRoot == null) return {unsupported: 'type @fit needs a field shorthand or a full object-scope claim'}
  const rangeText = rewriteRangeReferences(body, scope)
  if ('unsupported' in rangeText) return rangeText
  return {text: `${fieldRoot}: ${rangeText.text}`}
}

function rewriteRangeReferences(text: string, scope: TypeScope): TypeLineResult {
  const intRange = intRangePrefixPattern.exec(text.trim())
  if (intRange != null) {
    const body = rewriteExpressionReferences(intRange[2]!.trim(), scope)
    return 'unsupported' in body ? body : {text: `${intRange[1]!}${body.text}`}
  }
  return rewriteExpressionReferences(text.trim(), scope)
}

function rewriteExpressionReferences(text: string, scope: TypeScope): TypeLineResult {
  let rewritten = text
  for (const field of [...scope.requiredFields].sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(field)}(?![\\w$])`, 'g')
    rewritten = rewritten.replace(pattern, `${scope.root}.${field}`)
  }

  const rootName = rootBaseName(scope.root)
  identifierPattern.lastIndex = 0
  for (const match of rewritten.matchAll(identifierPattern)) {
    const name = match[1]!
    if (name === rootName || name === 'Infinity' || name === 'NaN' || name.startsWith('$')) continue
    if (scope.optionalFields.has(name)) return {unsupported: `type @fit reference "${name}" is optional; optional field contracts are not supported yet`}
    return {unsupported: `type @fit reference "${name}" is not a required field in this object scope`}
  }
  return {text: publicFitText(rewritten)}
}

function splitTopLevelColon(text: string): {left: string; right: string} | null {
  const index = findTopLevelToken(text, ':')
  if (index == null) return null
  const left = text.slice(0, index).trim()
  const right = text.slice(index + 1).trim()
  return left.length === 0 || right.length === 0 ? null : {left, right}
}

function findTopLevelComparison(text: string): TopLevelComparison | null {
  const index = scanTopLevel(text, (source, position) => {
    for (const op of ['==', '>=', '<=', '>', '<'] as const) {
      if (!source.startsWith(op, position)) continue
      if (op === '<' && source[position - 1] === '.') continue
      return op
    }
    return null
  })
  if (index == null) return null
  const {position, token: op} = index
  const left = text.slice(0, position).trim()
  const right = text.slice(position + op.length).trim()
  return left.length === 0 || right.length === 0 ? null : {left, op, right}
}

function findTopLevelToken(text: string, token: string): number | null {
  const result = scanTopLevel(text, (source, position) => source.startsWith(token, position) ? token : null)
  return result?.position ?? null
}

function scanTopLevel<T extends string>(text: string, visit: (source: string, position: number) => T | null): {position: number; token: T} | null {
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let index = 0; index < text.length; index++) {
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
    if (char === '(') parenDepth++
    else if (char === ')') parenDepth--
    else if (char === '[') bracketDepth++
    else if (char === ']') bracketDepth--
    else if (char === '{') braceDepth++
    else if (char === '}') braceDepth--
    else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const token = visit(text, index)
      if (token != null) return {position: index, token}
    }
  }
  return null
}

function typeAttachedCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  return uniqueLines([
    ...fitBlockSpecCommentLines(sourceText, node),
    ...inlineFitCommentLinesForNode(sourceText, node),
  ])
}

function objectBodyDetachedCommentLines(sourceText: string, node: ts.Node, members: ts.NodeArray<ts.TypeElement>): FitCommentLine[] {
  const range = objectBodyRange(sourceText, node)
  if (range == null) return []
  const attached = new Set(members.flatMap(member => typeAttachedCommentLines(sourceText, member)).map(commentLineKey))
  const lines: FitCommentLine[] = []
  for (const group of fitCommentLineGroupsInRange(sourceText, range.start, range.end)) {
    const groupLines = group.some(line => line.text === '@fit')
      ? group.filter(line => line.text.length > 0 && line.text !== '@fit' && !line.text.startsWith('@fit'))
      : group.filter(line => line.text.startsWith('@fit '))
    for (const line of groupLines) {
      if (attached.has(commentLineKey(line))) continue
      if (!isTopLevelInObjectBody(sourceText, range.start, line.pos)) continue
      lines.push(line)
    }
  }
  return uniqueLines(lines)
}

function isTopLevelInObjectBody(sourceText: string, start: number, position: number) {
  let depth = 0
  let quote: '"' | "'" | '`' | null = null
  for (let index = start; index < position; index++) {
    const char = sourceText[index]
    if (quote != null) {
      if (char === '\\') index++
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (sourceText.startsWith('//', index)) {
      const newline = sourceText.indexOf('\n', index + 2)
      if (newline < 0 || newline >= position) break
      index = newline
      continue
    }
    if (sourceText.startsWith('/*', index)) {
      const close = sourceText.indexOf('*/', index + 2)
      if (close < 0 || close >= position) break
      index = close + 1
      continue
    }
    if (char === '{') depth++
    else if (char === '}') depth--
  }
  return depth === 0
}

function objectBodyRange(sourceText: string, node: ts.Node): {start: number; end: number} | null {
  if (!ts.isInterfaceDeclaration(node) && !ts.isTypeLiteralNode(node)) return null
  const sourceFile = node.getSourceFile()
  const open = sourceText.indexOf('{', node.getStart(sourceFile))
  if (open < 0 || open >= node.end) return null
  const close = sourceText.lastIndexOf('}', node.end)
  if (close <= open) return null
  return {start: open + 1, end: close}
}

function parseUnsupportedAttachedSpecs(sourceText: string, node: ts.Node, reason: string): TypeContractResult<TypeContractSpec> {
  return unsupportedLines(typeAttachedCommentLines(sourceText, node), reason)
}

function unsupportedLines(lines: FitCommentLine[], reason: string): TypeContractResult<TypeContractSpec> {
  return {
    specs: [],
    unsupported: lines.map(line => ({
      text: typeCommentBody(line),
      reason,
      line: line.line,
    })),
  }
}

function typeCommentBody(line: FitCommentLine) {
  return line.text.startsWith('@fit') ? line.text.slice('@fit'.length).trim() : line.text.trim()
}

function objectScope(root: string, members: ts.NodeArray<ts.TypeElement>): TypeScope {
  const requiredFields = new Set<string>()
  const optionalFields = new Set<string>()
  for (const member of members) {
    if (!ts.isPropertySignature(member)) continue
    const name = propertyNameText(member.name)
    if (name == null) continue
    if (member.questionToken == null) requiredFields.add(name)
    else optionalFields.add(name)
  }
  return {root, requiredFields, optionalFields}
}

function localTypeDeclarationForReference(
  program: Program,
  type: ts.TypeReferenceNode,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  const checked = typeDeclarationFromTypeChecker(program, type)
  if (checked != null) return checked
  return ts.isIdentifier(type.typeName) ? localTypeDeclaration(type.getSourceFile(), type.typeName.text) : null
}

function typeDeclarationFromTypeChecker(
  program: Program,
  type: ts.TypeReferenceNode,
): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  if (program.typeChecker == null) return null
  const symbol = program.typeChecker.getSymbolAtLocation(type.typeName)
  const target = symbol != null && (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? program.typeChecker.getAliasedSymbol(symbol)
    : symbol
  const declaration = target?.declarations?.find(isTypeContractDeclaration) ?? null
  return declaration != null && isSupportedTypeContractSource(declaration.getSourceFile()) ? declaration : null
}

function localTypeDeclaration(sourceFile: ts.SourceFile, name: string): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | null {
  for (const statement of sourceFile.statements) {
    if ((ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name) return statement
  }
  return null
}

function isTypeContractDeclaration(node: ts.Declaration): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration {
  return ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
}

function isSupportedTypeContractSource(sourceFile: ts.SourceFile) {
  return !sourceFile.isDeclarationFile
    && isSupportedTypeContractPath(sourceFile.fileName)
    && !isNodeModulesPath(sourceFile.fileName)
}

function isSupportedTypeContractPath(file: string) {
  return file.endsWith('.ts')
    || file.endsWith('.tsx')
    || file.endsWith('.mts')
    || file.endsWith('.cts')
}

function isNodeModulesPath(file: string) {
  return normalizePath(file).split('/').includes('node_modules')
}

function normalizePath(file: string) {
  return file.replace(/\\/g, '/')
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function rootBaseName(root: string) {
  const match = /^([A-Za-z_$][\w$]*)/.exec(root)
  return match?.[1] ?? root
}

function mergeResults<T extends TypeContractSpec>(results: TypeContractResult<T>[]): TypeContractResult<T> {
  return {
    specs: results.flatMap(result => result.specs),
    unsupported: results.flatMap(result => result.unsupported),
  }
}

function emptyResult<T extends TypeContractSpec>(): TypeContractResult<T> {
  return {specs: [], unsupported: []}
}

function dedupeResult<T extends TypeContractSpec>(result: TypeContractResult<T>): TypeContractResult<T> {
  return {
    specs: dedupeSpecs(result.specs),
    unsupported: dedupeUnsupported(result.unsupported),
  }
}

function relocateTypeContractLocations<T extends TypeContractSpec>(result: TypeContractResult<T>, line: number): TypeContractResult<T> {
  return {
    specs: result.specs.map(spec => ({...spec, line})),
    unsupported: result.unsupported.map(problem => ({...problem, line})),
  }
}

function lineNumberForNode(node: ts.Node) {
  const sourceFile = node.getSourceFile()
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

function dedupeSpecs<T extends TypeContractSpec>(specs: T[]): T[] {
  const seen = new Set<string>()
  const result: T[] = []
  for (const spec of specs) {
    const key = `${spec.kind}\0${spec.text}\0${spec.line ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(spec)
  }
  return result
}

function dedupeUnsupported(items: TypeContractUnsupported[]) {
  const seen = new Set<string>()
  const result: TypeContractUnsupported[] = []
  for (const item of items) {
    const key = `${item.text}\0${item.reason}\0${item.line ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

function uniqueLines(lines: FitCommentLine[]) {
  const seen = new Set<string>()
  const unique: FitCommentLine[] = []
  for (const line of lines) {
    const key = commentLineKey(line)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(line)
  }
  return unique
}

function commentLineKey(line: FitCommentLine) {
  return `${line.line}:${line.text}`
}

function escapeRegExp(text: string) {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}
