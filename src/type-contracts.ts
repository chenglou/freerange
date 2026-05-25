import * as ts from 'typescript'
import {
  domainPathSyntheticName,
  findTopLevelColon,
  findTopLevelComparison,
  fitBlockSpecCommentLines,
  fitSpecTextForRole,
  fitReturnPublicRoot,
  inlineFitCommentLinesForNode,
  normalizeFitText,
  parseDomainPathText,
  parseFitExpressionText,
  parseFitRangeText,
  publicFitText,
  withFitExpressionScope,
  type ComparisonOperator,
  type FitCheckSpec,
  type FitCommentLine,
  type FitDomainPath,
  type FitExpression,
  type FitGivenSpec,
  type FitRange,
  type FitSpecRole,
} from './parser.ts'
import {type FitFunction} from './modules.ts'
import {type Program} from './check-types.ts'

type TypeContractSpec = FitCheckSpec | FitGivenSpec

const typeContractTemplateRoot = '__fit_type_root'

export type TypeContractUnsupported = {
  text: string
  reason: string
  line?: number
}

export type TypeContractResult<T extends TypeContractSpec> = {
  specs: T[]
  unsupported: TypeContractUnsupported[]
}

export type TypeContractTemplate =
  | {
      kind: 'range'
      scopeSourceId?: string
      expression: FitExpression
      range: FitRange
      line?: number
    }
  | {
      kind: 'comparison'
      scopeSourceId?: string
      left: FitExpression
      op: ComparisonOperator
      right: FitExpression
      line?: number
    }

export type TypeContractTemplateResult = {
  templates: TypeContractTemplate[]
  unsupported: TypeContractUnsupported[]
}

export type TypeContractTemplateIndex = {
  byNode: Map<ts.Node, TypeContractTemplateResult>
}

type TypeScope = {
  root: string
  requiredFields: Set<string>
  optionalFields: Set<string>
}

type TypeLineResult = {
  template: TypeContractTemplate
} | {
  unsupported: string
}

type TypeTextResult = {
  text: string
} | {
  unsupported: string
}

const identifierPattern = /(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$])/g
const shorthandComparisonPattern = /^(==|>=|<=|>|<)\s*(.+)$/
const intRangePrefixPattern = /^(int\s+)([\s\S]+)$/
const givenKeywordPattern = /^given(?:\s|$)/
const typeContractTemplateRootPattern = /(?<![\w$.])__fit_type_root(?![\w$])/g
const typeContractTemplatePathPattern = /(?<![\w$.])__fit_type_root(?:\.[A-Za-z_$][\w$]*|\[\]|\[\$[A-Za-z_][\w$]*(?:\s*[+-]\s*\d+)?\])*/g

export function createTypeContractTemplateIndex(sourceText: string, sourceFile: ts.SourceFile): TypeContractTemplateIndex {
  const index = emptyTypeContractTemplateIndex()
  const visit = (node: ts.Node) => {
    if (ts.isInterfaceDeclaration(node)) {
      collectObjectMemberContractTemplates(sourceText, node.members, [node], index)
      return
    }
    if (ts.isTypeAliasDeclaration(node)) {
      if (ts.isTypeLiteralNode(node.type)) {
        collectObjectMemberContractTemplates(sourceText, node.type.members, [node, node.type], index)
      } else {
        setTypeContractTemplates(index, node, parseScalarTypeAttachedTemplates(sourceText, node))
        ts.forEachChild(node, visit)
      }
      return
    }
    if (ts.isTypeLiteralNode(node)) {
      collectObjectFieldContractTemplates(sourceText, node.members, index)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return index
}

function emptyTypeContractTemplateIndex(): TypeContractTemplateIndex {
  return {byNode: new Map()}
}

function collectObjectMemberContractTemplates(
  sourceText: string,
  members: ts.NodeArray<ts.TypeElement>,
  scopeNodes: ts.Node[],
  index: TypeContractTemplateIndex,
) {
  const scope = objectScope(typeContractTemplateRoot, members)
  for (const node of scopeNodes) {
    setTypeContractTemplates(index, node, parseObjectScopeAttachedTemplates(sourceText, node, scope))
  }
  collectObjectFieldContractTemplates(sourceText, members, index)
}

function collectObjectFieldContractTemplates(
  sourceText: string,
  members: ts.NodeArray<ts.TypeElement>,
  index: TypeContractTemplateIndex,
) {
  const scope = objectScope(typeContractTemplateRoot, members)
  for (const member of members) {
    if (!ts.isPropertySignature(member)) {
      setTypeContractTemplates(index, member, parseUnsupportedAttachedTemplates(sourceText, member, 'type @fit supports property fields only'))
      continue
    }

    const attachedLines = typeAttachedCommentLines(sourceText, member)
    const name = propertyNameText(member.name)
    if (name == null) {
      if (attachedLines.length > 0) {
        setTypeContractTemplates(index, member, unsupportedTemplateLines(attachedLines, 'type @fit supports identifier, string, and numeric property names'))
      }
      continue
    }

    if (member.questionToken != null) {
      if (attachedLines.length > 0) {
        setTypeContractTemplates(index, member, unsupportedTemplateLines(attachedLines, 'type @fit on optional fields is not supported yet'))
      }
      continue
    }

    const fieldRoot = `${typeContractTemplateRoot}.${name}`
    setTypeContractTemplates(index, member, parsePropertyAttachedTemplates(sourceText, member, fieldRoot, scope))
    ts.forEachChild(member, child => {
      if (ts.isTypeNode(child)) visitTypeContractFieldTemplateChild(sourceText, child, index)
    })
  }
}

function visitTypeContractFieldTemplateChild(sourceText: string, node: ts.Node, index: TypeContractTemplateIndex) {
  const visit = (child: ts.Node) => {
    if (ts.isTypeLiteralNode(child)) {
      collectObjectFieldContractTemplates(sourceText, child.members, index)
      return
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
}

function setTypeContractTemplates(index: TypeContractTemplateIndex, node: ts.Node, result: TypeContractTemplateResult) {
  const scopeSourceId = node.getSourceFile().fileName
  index.byNode.set(node, {
    unsupported: result.unsupported,
    templates: result.templates.map(template => ({...template, scopeSourceId})),
  })
}

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
  return dedupeResult(collectTypeContractSpecs(program, type, root, 'prove', new Set()) as TypeContractResult<FitCheckSpec>)
}

function typeGivenContractForTypeNode(program: Program, type: ts.TypeNode | undefined, root: string): TypeContractResult<FitGivenSpec> {
  return dedupeResult(collectTypeContractSpecs(program, type, root, 'assume', new Set()) as TypeContractResult<FitGivenSpec>)
}

function collectTypeContractSpecs(
  program: Program,
  type: ts.TypeNode | undefined,
  root: string,
  role: FitSpecRole,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  if (type == null) return emptyResult()

  if (ts.isParenthesizedTypeNode(type)) return collectTypeContractSpecs(program, type.type, root, role, seen)
  if (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return collectTypeContractSpecs(program, type.type, root, role, seen)
  }
  if (ts.isArrayTypeNode(type)) return collectTypeContractSpecs(program, type.elementType, `${root}[]`, role, seen)
  if (ts.isIntersectionTypeNode(type)) {
    return mergeResults(type.types.map(member => collectTypeContractSpecs(program, member, root, role, seen)))
  }
  if (ts.isTypeLiteralNode(type)) return collectObjectMemberContractSpecs(program, type.members, root, role, seen, [type])
  if (ts.isTypeReferenceNode(type)) return collectTypeReferenceContractSpecs(program, type, root, role, seen)
  return emptyResult()
}

function collectTypeReferenceContractSpecs(
  program: Program,
  type: ts.TypeReferenceNode,
  root: string,
  role: FitSpecRole,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  const name = ts.isIdentifier(type.typeName) ? type.typeName.text : null
  const typeArgument = type.typeArguments?.[0]
  if ((name === 'Array' || name === 'ReadonlyArray') && typeArgument != null) {
    return collectTypeContractSpecs(program, typeArgument, `${root}[]`, role, seen)
  }

  const declaration = localTypeDeclarationForReference(program, type)
  if (declaration == null) return instantiateTypeContractTemplates(parseUnsupportedAttachedTemplates(type.getSourceFile().text, type, 'type @fit supports source-backed type references'), root, role)
  const key = `${declaration.getSourceFile().fileName}#${declaration.name?.text ?? declaration.pos}`
  if (seen.has(key)) return emptyResult()
  seen.add(key)

  const specs = ts.isInterfaceDeclaration(declaration)
    ? collectObjectMemberContractSpecs(program, declaration.members, root, role, seen, [declaration])
    : collectTypeAliasContractSpecs(program, declaration, root, role, seen)
  seen.delete(key)
  return declaration.getSourceFile() === program.sourceFile ? specs : relocateTypeContractLocations(specs, lineNumberForNode(type))
}

function collectTypeAliasContractSpecs(
  program: Program,
  declaration: ts.TypeAliasDeclaration,
  root: string,
  role: FitSpecRole,
  seen: Set<string>,
): TypeContractResult<TypeContractSpec> {
  if (ts.isTypeLiteralNode(declaration.type)) {
    return collectObjectMemberContractSpecs(program, declaration.type.members, root, role, seen, [declaration, declaration.type])
  }
  return mergeResults([
    instantiateTypeContractTemplates(typeTemplatesForNode(program, declaration), root, role),
    collectTypeContractSpecs(program, declaration.type, root, role, seen),
  ])
}

function collectObjectMemberContractSpecs(
  program: Program,
  members: ts.NodeArray<ts.TypeElement>,
  root: string,
  role: FitSpecRole,
  seen: Set<string>,
  scopeNodes: ts.Node[],
): TypeContractResult<TypeContractSpec> {
  const results = scopeNodes.map(node => instantiateTypeContractTemplates(typeTemplatesForNode(program, node), root, role))

  for (const member of members) {
    if (!ts.isPropertySignature(member)) {
      results.push(instantiateTypeContractTemplates(typeTemplatesForNode(program, member), root, role))
      continue
    }

    const name = propertyNameText(member.name)
    if (name == null) {
      results.push(instantiateTypeContractTemplates(typeTemplatesForNode(program, member), root, role))
      continue
    }

    if (member.questionToken != null) {
      results.push(instantiateTypeContractTemplates(typeTemplatesForNode(program, member), root, role))
      continue
    }

    const propRoot = `${root}.${name}`
    results.push(instantiateTypeContractTemplates(typeTemplatesForNode(program, member), root, role))
    results.push(collectTypeContractSpecs(program, member.type, propRoot, role, seen))
  }
  return mergeResults(results)
}

function templateIndexForNode(program: Program, node: ts.Node): TypeContractTemplateIndex {
  const sourceFile = node.getSourceFile()
  const file = program.project.filesBySourceFile.get(sourceFile)
  if (file == null) throw new Error(`Missing parsed file for type @fit contracts in ${sourceFile.fileName}`)
  return file.typeContracts
}

function typeTemplatesForNode(program: Program, node: ts.Node): TypeContractTemplateResult {
  return templateIndexForNode(program, node).byNode.get(node) ?? emptyTemplateResult()
}

function emptyTemplateResult(): TypeContractTemplateResult {
  return {templates: [], unsupported: []}
}

function instantiateTypeContractTemplates(
  result: TypeContractTemplateResult,
  root: string,
  role: FitSpecRole,
): TypeContractResult<TypeContractSpec> {
  const specs: TypeContractSpec[] = []
  const unsupported = [...result.unsupported]
  for (const template of result.templates) {
    specs.push(instantiateTypeContractTemplate(template, root, role))
  }
  return {specs, unsupported}
}

function instantiateTypeContractTemplate(template: TypeContractTemplate, root: string, role: FitSpecRole): TypeContractSpec {
  switch (template.kind) {
    case 'range': {
      const expression = instantiateTypeTemplateExpression(template.expression, root, template.scopeSourceId)
      const range = instantiateTypeTemplateRange(template.range, root, template.scopeSourceId)
      const text = fitSpecTextForRole(role, `${publicFitText(expression.text)}: ${range.text}`)
      return {
        role,
        kind: 'range',
        expression,
        range,
        text,
        ...(template.line == null ? {} : {line: template.line}),
      }
    }
    case 'comparison': {
      const left = instantiateTypeTemplateExpression(template.left, root, template.scopeSourceId)
      const right = instantiateTypeTemplateExpression(template.right, root, template.scopeSourceId)
      const text = fitSpecTextForRole(role, `${publicFitText(left.text)} ${template.op} ${publicFitText(right.text)}`)
      return {
        role,
        kind: 'comparison',
        left,
        op: template.op,
        right,
        text,
        ...(template.line == null ? {} : {line: template.line}),
      }
    }
  }
}

function instantiateTypeTemplateRange(range: FitRange, root: string, scopeSourceId: string | undefined): FitRange {
  return {
    ...range,
    lower: instantiateTypeTemplateExpression(range.lower, root, scopeSourceId),
    upper: instantiateTypeTemplateExpression(range.upper, root, scopeSourceId),
    ...(range.alternatives == null ? {} : {
      alternatives: range.alternatives.map(rangeCase => ({
        ...rangeCase,
        lower: instantiateTypeTemplateExpression(rangeCase.lower, root, scopeSourceId),
        upper: instantiateTypeTemplateExpression(rangeCase.upper, root, scopeSourceId),
      })),
    }),
    text: instantiateTypeContractTemplateText(range.text, root),
  }
}

function instantiateTypeTemplateExpression(expression: FitExpression, root: string, scopeSourceId: string | undefined): FitExpression {
  const domainPaths = new Map<string, FitDomainPath>()
  for (const [name, domainPath] of expression.parsed.domainPaths) {
    domainPaths.set(name, instantiateTypeTemplateDomainPath(domainPath, root))
  }
  return withFitExpressionScope({
    text: normalizeFitText(instantiateTypeContractTemplateText(expression.text, root)),
    parsed: {expression: expression.parsed.expression, domainPaths},
  }, scopeSourceId)
}

function instantiateTypeTemplateDomainPath(domainPath: FitDomainPath, root: string): FitDomainPath {
  if (domainPath.root !== typeContractTemplateRoot) return domainPath
  const rootPath = typeRootPath(root)
  return {
    root: rootPath.root,
    segments: [...rootPath.segments, ...domainPath.segments],
  }
}

function typeRootPath(root: string): FitDomainPath {
  const normalized = normalizeFitText(root)
  const domainPath = parseDomainPathText(normalized)
  return domainPath ?? {root: normalized, segments: []}
}

function instantiateTypeContractTemplateText(text: string, root: string) {
  return publicFitText(text.replace(typeContractTemplateRootPattern, root))
}

function parseScalarTypeAttachedTemplates(sourceText: string, node: ts.Node): TypeContractTemplateResult {
  const fieldScope: TypeScope = {root: typeContractTemplateRoot, requiredFields: new Set(), optionalFields: new Set()}
  return parseTypeCommentTemplateLines(typeAttachedCommentLines(sourceText, node), fieldScope, typeContractTemplateRoot)
}

function parseObjectScopeAttachedTemplates(sourceText: string, node: ts.Node, scope: TypeScope): TypeContractTemplateResult {
  return parseTypeCommentTemplateLines(typeAttachedCommentLines(sourceText, node), scope, null)
}

function parsePropertyAttachedTemplates(
  sourceText: string,
  node: ts.Node,
  fieldRoot: string,
  scope: TypeScope,
): TypeContractTemplateResult {
  return parseTypeCommentTemplateLines(typeAttachedCommentLines(sourceText, node), scope, fieldRoot, {requireFieldRoot: true})
}

function parseTypeCommentTemplateLines(
  lines: FitCommentLine[],
  scope: TypeScope,
  fieldRoot: string | null,
  options: {requireFieldRoot?: boolean} = {},
): TypeContractTemplateResult {
  const templates: TypeContractTemplate[] = []
  const unsupported: TypeContractUnsupported[] = []
  for (const line of lines) {
    const body = typeCommentBody(line)
    if (body.length === 0) continue
    if (givenKeywordPattern.test(body)) {
      unsupported.push({text: body, reason: 'type @fit lines do not use given; write the field fact without given', line: line.line})
      continue
    }
    const parsed = typeLineText(body, scope, fieldRoot, options)
    if ('unsupported' in parsed) {
      unsupported.push({text: body, reason: parsed.unsupported, line: line.line})
      continue
    }
    templates.push({...parsed.template, line: line.line})
  }
  return {templates, unsupported}
}

function typeLineText(
  body: string,
  scope: TypeScope,
  fieldRoot: string | null,
  options: {requireFieldRoot?: boolean} = {},
): TypeLineResult {
  const shorthandComparison = shorthandComparisonPattern.exec(body)
  if (shorthandComparison != null) {
    if (fieldRoot == null) return {unsupported: 'type @fit shorthand needs a field to attach to'}
    const right = rewriteExpressionReferences(shorthandComparison[2]!.trim(), scope)
    if ('unsupported' in right) return right
    return parseTypeComparisonTemplate(fieldRoot, shorthandComparison[1]! as ComparisonOperator, right.text)
  }

  const range = findTopLevelColon(body)
  if (range != null) {
    const expression = rewriteExpressionReferences(range.left, scope)
    if ('unsupported' in expression) return expression
    if (options.requireFieldRoot === true && !expressionDescribesField(expression.text, fieldRoot)) {
      return {unsupported: 'type @fit attached to a field must describe that field; put object-scope facts on the type block'}
    }
    const rangeText = rewriteRangeReferences(range.right, scope)
    if ('unsupported' in rangeText) return rangeText
    return parseTypeRangeTemplate(expression.text, rangeText.text)
  }

  const comparison = findTopLevelComparison(body)
  if (comparison != null) {
    const left = rewriteExpressionReferences(comparison.left, scope)
    if ('unsupported' in left) return left
    if (options.requireFieldRoot === true && !expressionDescribesField(left.text, fieldRoot)) {
      return {unsupported: 'type @fit attached to a field must describe that field; put object-scope facts on the type block'}
    }
    const right = rewriteExpressionReferences(comparison.right, scope)
    if ('unsupported' in right) return right
    return parseTypeComparisonTemplate(left.text, comparison.op, right.text)
  }

  if (fieldRoot == null) return {unsupported: 'type @fit needs a field shorthand or a full object-scope claim'}
  const rangeText = rewriteRangeReferences(body, scope)
  if ('unsupported' in rangeText) return rangeText
  return parseTypeRangeTemplate(fieldRoot, rangeText.text)
}

function parseTypeRangeTemplate(expressionText: string, rangeText: string): TypeLineResult {
  try {
    const expression = parseTypeTemplateExpression(expressionText)
    const range = parseFitRangeText(rangeText, parseTypeTemplateExpression)
    if (range == null) return {unsupported: `Unsupported @fit range: ${expressionText}: ${rangeText}`}
    return {
      template: {
        kind: 'range',
        expression,
        range,
      },
    }
  } catch (error) {
    return {unsupported: error instanceof Error ? error.message : String(error)}
  }
}

function parseTypeComparisonTemplate(leftText: string, op: ComparisonOperator, rightText: string): TypeLineResult {
  try {
    const left = parseTypeTemplateExpression(leftText)
    const right = parseTypeTemplateExpression(rightText)
    return {
      template: {
        kind: 'comparison',
        left,
        op,
        right,
      },
    }
  } catch (error) {
    return {unsupported: error instanceof Error ? error.message : String(error)}
  }
}

function parseTypeTemplateExpression(text: string): FitExpression {
  const normalized = normalizeFitText(text)
  const domainPaths = new Map<string, FitDomainPath>()
  const sourceText = normalized.replace(typeContractTemplatePathPattern, match => {
    const domainPath = parseDomainPathText(match)
    if (domainPath == null) return match
    const synthetic = domainPathSyntheticName(match)
    domainPaths.set(synthetic, domainPath)
    return synthetic
  })
  const parsed = parseFitExpressionText(sourceText)
  return {
    text: normalized,
    parsed: {
      expression: parsed.parsed.expression,
      domainPaths: new Map([...parsed.parsed.domainPaths, ...domainPaths]),
    },
  }
}

function expressionDescribesField(text: string, fieldRoot: string | null) {
  if (fieldRoot == null) return false
  const root = publicFitText(fieldRoot)
  return text === root || text.startsWith(`${root}.`) || text.startsWith(`${root}[`)
}

function rewriteRangeReferences(text: string, scope: TypeScope): TypeTextResult {
  const intRange = intRangePrefixPattern.exec(text.trim())
  if (intRange != null) {
    const body = rewriteExpressionReferences(intRange[2]!.trim(), scope)
    return 'unsupported' in body ? body : {text: `${intRange[1]!}${body.text}`}
  }
  return rewriteExpressionReferences(text.trim(), scope)
}

function rewriteExpressionReferences(text: string, scope: TypeScope): TypeTextResult {
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
  }
  return {text: publicFitText(rewritten)}
}


function typeAttachedCommentLines(sourceText: string, node: ts.Node): FitCommentLine[] {
  return uniqueLines([
    ...fitBlockSpecCommentLines(sourceText, node),
    ...inlineFitCommentLinesForNode(sourceText, node),
  ])
}

function parseUnsupportedAttachedTemplates(sourceText: string, node: ts.Node, reason: string): TypeContractTemplateResult {
  return unsupportedTemplateLines(typeAttachedCommentLines(sourceText, node), reason)
}

function unsupportedTemplateLines(lines: FitCommentLine[], reason: string): TypeContractTemplateResult {
  return {
    templates: [],
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
    const key = `${spec.role}\0${spec.kind}\0${spec.text}\0${spec.line ?? ''}`
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
