import * as ts from 'typescript'
import type {FitCheck, Program} from './check-types.ts'
import {
  emptyTypeContract,
  functionContractSpecs,
  mergeTypeContracts,
  typeCheckContractForExpressionBoundary,
} from './function-contracts.ts'
import {
  instantiateTypeContractTemplateForCheck,
  typeCheckContractForTypeNode,
  type TypeContractTemplate,
} from './type-contracts.ts'
import type {FitFunction} from './modules.ts'
import {formatTypeScriptDiagnostics} from './ts-diagnostics.ts'
import {
  fitExpressionParsed,
  fitExpressionScopeSourceId,
  fitExpressionText,
  fitRangeCases,
  fitReturnInternalRoot,
  fitValueSpecExpressions,
  parseDomainPathText,
  type FitBodySpecIndex,
  type FitDomainPath,
  type FitDomainPathSegment,
  type FitExpressionLike,
  type FitInlineSpecTemplate,
  type FitRange,
  type FitSpec,
} from './parser.ts'

type ContractTypeCheckEntry = {
  key?: string
  sourceFile: ts.SourceFile
  file: string
  functionName: string
  text: string
  line?: number
  ignore?: boolean
}

type GeneratedBlock = {
  text: string
  entry: ContractTypeCheckEntry
}

type Edit = {
  start: number
  end: number
  blocks: GeneratedBlock[]
  replacementSuffix?: string
}

type Span = ContractTypeCheckEntry & {
  start: number
  end: number
}

type VirtualTypeCheckSource = {
  originalSourceId: string
  virtualSourceId: string
  text: string
  spans: Span[]
}

type ContractTypeCheckResult = {
  checks: FitCheck[]
  failedKeys: Set<string>
}

type TypeCheckSource = {
  project: Program['project']
  sourceId: string
  file: string
  sourceFile: ts.SourceFile
  sourceText: string
  typeContracts: Program['typeContracts']
}

type LoweredExpression = {
  expression: string
  prelude: string[]
}

type LowerOptions = {
  program: TypeCheckSource
  returnName: string
  typeContractSourceIds?: Set<string>
}

const contractTypeCheckCache = new WeakMap<Program, ContractTypeCheckResult>()
const fitNumberTypeName = '__FRNumber'
const returnValueName = '__fit_return'
const builtinNames = new Set(['nondecreasing', 'spaced', 'lastEnd', 'extentEnd', 'noOverlap'])
const identifierPattern = '[A-Za-z_$][\\w$]*'
const indexLabelPattern = '\\$[A-Za-z_][\\w$]*(?:\\s*[+-]\\s*\\d+)?'
const domainPathPattern = new RegExp(`${identifierPattern}(?:(?:\\.${identifierPattern})|(?:\\[(?:\\]|${indexLabelPattern}\\])))+`, 'g')
const typePrinter = ts.createPrinter({removeComments: true})
let generatedId = 0

export function contractTypeChecksForFunction(program: Program, fn: FitFunction): FitCheck[] {
  return contractTypeCheckResult(program).checks.filter(check => check.functionName === fn.name || check.functionName.startsWith(`${fn.name} >`))
}

export function contractTypeChecksForTopLevel(program: Program): FitCheck[] {
  return contractTypeCheckResult(program).checks.filter(check => check.functionName === '<top-level>' || check.functionName === '<type>')
}

export function filterTypeCheckedSpecs<T extends FitSpec>(program: Program, specs: T[]): T[] {
  const failed = contractTypeCheckResult(program).failedKeys
  return specs.filter(spec => !failed.has(specKey(spec)))
}

export function filterTypeCheckedInlineTemplates<T extends FitInlineSpecTemplate>(program: Program, templates: T[]): T[] {
  const failed = contractTypeCheckResult(program).failedKeys
  return templates.filter(template => !failed.has(inlineTemplateKey(template)))
}

function contractTypeCheckResult(program: Program): ContractTypeCheckResult {
  const cached = contractTypeCheckCache.get(program)
  if (cached != null) return cached
  const built = buildContractTypeChecks(program)
  contractTypeCheckCache.set(program, built)
  return built
}

function buildContractTypeChecks(program: Program): ContractTypeCheckResult {
  const builder = new VirtualContractTypeCheckBuilder(program)
  for (const fn of program.functions.values()) builder.addFunction(fn)
  builder.addTopLevel()
  const virtuals: VirtualTypeCheckSource[] = []
  const main = builder.build(declarationTypeCheckEdits(program))
  if (main.spans.length > 0) {
    virtuals.push({
      originalSourceId: program.sourceId,
      virtualSourceId: virtualTypeCheckSourceId(program.sourceId),
      text: main.text,
      spans: main.spans,
    })
  }
  const declarationSourceIds = new Set(builder.referencedTypeContractSourceIds)
  for (const source of program.project.files.values()) {
    if (source.sourceId === program.sourceId) continue
    if (!declarationSourceIds.has(source.sourceId)) continue
    const declarationChecks = buildDeclarationTypeChecks(source)
    if (declarationChecks.spans.length === 0) continue
    virtuals.push({
      originalSourceId: source.sourceId,
      virtualSourceId: virtualTypeCheckSourceId(source.sourceId),
      text: declarationChecks.text,
      spans: declarationChecks.spans,
    })
  }
  if (virtuals.length === 0) return {checks: [], failedKeys: new Set()}

  const virtualBySourceId = new Map(virtuals.map(virtual => [virtual.virtualSourceId, {
    sourceFile: ts.createSourceFile(virtual.virtualSourceId, virtual.text, ts.ScriptTarget.Latest, true, scriptKindForVirtualSource(virtual.originalSourceId)),
    text: virtual.text,
  }]))
  const compilerOptions = {...program.project.compilerOptions, allowJs: true, noEmit: true}
  const host = ts.createCompilerHost(compilerOptions)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  const baseReadFile = host.readFile.bind(host)
  const baseFileExists = host.fileExists.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const virtual = virtualBySourceId.get(normalizePath(fileName))
    if (virtual != null) return virtual.sourceFile
    return baseGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  }
  host.readFile = fileName => virtualBySourceId.get(normalizePath(fileName))?.text ?? baseReadFile(fileName)
  host.fileExists = fileName => virtualBySourceId.has(normalizePath(fileName)) ? true : baseFileExists(fileName)
  const rootNames = virtualRootNames(program.project.rootNames, virtuals)
  const typeProgram = ts.createProgram(rootNames, compilerOptions, host)
  const diagnostics = virtuals.flatMap(virtual => {
    const checkedSource = typeProgram.getSourceFile(virtual.virtualSourceId) ?? virtualBySourceId.get(virtual.virtualSourceId)!.sourceFile
    return [
      ...typeProgram.getSyntacticDiagnostics(checkedSource),
      ...typeProgram.getSemanticDiagnostics(checkedSource),
    ]
  })
  return checksFromDiagnostics(diagnostics, virtuals.flatMap(virtual => virtual.spans))
}

class VirtualContractTypeCheckBuilder {
  private edits: Edit[] = []
  private returnEdits = new Map<ts.ReturnStatement, Edit>()
  readonly referencedTypeContractSourceIds = new Set<string>()

  constructor(private readonly program: Program) {}

  addFunction(fn: FitFunction) {
    const body = fn.node.body
    const returnType = returnContextType(fn, this.program.sourceFile)
    const contractSpecs = functionContractSpecs(this.program, fn)
    const bodyStartSpecs = contractSpecs.filter(spec => !specMentionsReturn(spec))
    const returnSpecs = contractSpecs.filter(spec => specMentionsReturn(spec))

    if (body != null && bodyStartSpecs.length > 0) {
      if (ts.isBlock(body)) this.addInsertion(body.getStart(this.program.sourceFile) + 1, blocksForSpecs(this.program, fn.name, bodyStartSpecs, this.lowerOptions()))
    }

    if (body != null && ts.isBlock(body)) {
      this.addFunctionBodySpecs(fn, returnType)
      this.addFunctionTypeBoundaryChecks(fn, returnType)
      for (const statement of returnStatementsIn(body)) {
        if (statement.expression == null) continue
        this.addReturnReplacement(fn.name, statement, returnSpecs, returnType)
      }
    } else if (body != null && ts.isArrowFunction(fn.node) && ts.isExpression(body)) {
      const blocks = [
        ...blocksForSpecs(this.program, fn.name, bodyStartSpecs, this.lowerOptions()),
        ...blocksForSpecs(this.program, fn.name, returnSpecs, this.lowerOptions()),
      ]
      if (blocks.length > 0) this.replaceArrowExpressionBody(fn.name, body, blocks, returnType)
    }
  }

  addTopLevel() {
    this.addBodySpecIndex('<top-level>', this.program.topLevelBodySpecs)
  }

  build(extraEdits: Edit[] = []): {text: string; spans: Span[]} {
    return buildEditedSource(this.program.sourceText, [...this.edits, ...extraEdits])
  }

  private addFunctionBodySpecs(fn: FitFunction, returnType: string | null) {
    this.addBodySpecIndex(fn.name, fn.bodySpecs, returnType)
  }

  private addBodySpecIndex(functionName: string, index: FitBodySpecIndex, returnType: string | null = null) {
    for (const [statement, specs] of index.localSpecsByStatement) {
      this.addInsertion(statement.end, blocksForSpecs(this.program, functionName, specs, this.lowerOptions()))
    }
    for (const [node, specs] of index.returnSpecsByNode) {
      if (ts.isReturnStatement(node) && node.expression != null) {
        this.addReturnReplacement(functionName, node, specs, returnType)
      }
    }
    for (const [statement, specs] of index.loopSpecsByStatement) {
      const loopName = `${functionName} > loop`
      this.addInsertion(statement.end, blocksForSpecs(this.program, loopName, specs.filter(spec => !specMentionsReturn(spec)), this.lowerOptions()))
    }
    for (const [property, templates] of index.objectPropertyTemplatesByNode) {
      const statement = containingStatement(property)
      if (statement == null) continue
      const valueText = propertyValueExpressionText(property, this.program.sourceFile)
      if (valueText == null) continue
      const blocks = blocksForInlineTemplates(this.program, functionName, templates, valueText)
      this.addInsertion(statement.getStart(this.program.sourceFile), blocks)
    }
  }

  private addFunctionTypeBoundaryChecks(fn: FitFunction, returnType: string | null) {
    if (fn.node.body == null || !ts.isBlock(fn.node.body)) return
    const visit = (node: ts.Node) => {
      if (node !== fn.node.body && isFunctionLikeWithBody(node)) return
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const typeContract = mergeTypeContracts([
          typeCheckContractForTypeNode(this.program, node.type, node.name.text),
          node.initializer == null
            ? emptyTypeContract()
            : typeCheckContractForExpressionBoundary(this.program, node.initializer, node.name.text),
        ])
        if (typeContract.specs.length > 0) {
          const statement = containingStatement(node)
          if (statement != null) this.addInsertion(statement.end, blocksForSpecs(this.program, fn.name, typeContract.specs, this.lowerOptions()))
        }
      }
      if (ts.isReturnStatement(node) && node.expression != null) {
        const typeContract = typeCheckContractForExpressionBoundary(this.program, node.expression, returnValueName)
        if (typeContract.specs.length > 0) this.addReturnReplacement(fn.name, node, typeContract.specs, returnType)
      }
      ts.forEachChild(node, visit)
    }
    visit(fn.node.body)
  }

  private addReturnReplacement(functionName: string, statement: ts.ReturnStatement, specs: FitSpec[], returnType: string | null) {
    if (statement.expression == null || specs.length === 0) return
    const expression = statement.expression.getText(this.program.sourceFile)
    const blocks = blocksForSpecs(this.program, functionName, specs, this.lowerOptions())
    if (blocks.length === 0) return
    const edit = this.returnEdits.get(statement) ?? this.createReturnReplacement(functionName, statement, expression, returnType)
    edit.blocks.push(...blocks)
  }

  private createReturnReplacement(functionName: string, statement: ts.ReturnStatement, expression: string, returnType: string | null): Edit {
    const line = lineNumberForNode(this.program.sourceFile, statement)
    const originalReturn = statement.getText(this.program.sourceFile)
    const edit: Edit = {
      start: statement.getStart(this.program.sourceFile),
      end: statement.end,
      blocks: [{
        text: `\n{\nconst ${returnValueName} = ${contextualReturnExpression(expression, returnType)}; void ${returnValueName};\n`,
        entry: {sourceFile: this.program.sourceFile, file: this.program.file, functionName, text: '<return value>', line, ignore: true},
      }],
      replacementSuffix: `${originalReturn}\n}\n`,
    }
    this.returnEdits.set(statement, edit)
    this.edits.push(edit)
    return edit
  }

  private replaceArrowExpressionBody(functionName: string, body: ts.Expression, blocks: GeneratedBlock[], returnType: string | null) {
    const expression = body.getText(this.program.sourceFile)
    this.edits.push({
      start: body.getStart(this.program.sourceFile),
      end: body.end,
      blocks: [{
        text: `{ const ${returnValueName} = ${contextualReturnExpression(expression, returnType)}; void ${returnValueName};\n`,
        entry: {sourceFile: this.program.sourceFile, file: this.program.file, functionName, text: '<return value>', line: lineNumberForNode(this.program.sourceFile, body), ignore: true},
      }, ...blocks],
      replacementSuffix: `return ${returnValueName} }`,
    })
  }

  private addInsertion(position: number, blocks: GeneratedBlock[]) {
    if (blocks.length === 0) return
    this.edits.push({start: position, end: position, blocks})
  }

  private lowerOptions(): LowerOptions {
    return lowerOptions(this.program, this.referencedTypeContractSourceIds)
  }
}

function buildDeclarationTypeChecks(source: TypeCheckSource): {text: string; spans: Span[]} {
  return buildEditedSource(source.sourceText, declarationTypeCheckEdits(source))
}

function declarationTypeCheckEdits(source: TypeCheckSource): Edit[] {
  const edits: Edit[] = []
  for (const [node, result] of source.typeContracts.byNode) {
    if (result.templates.length === 0) continue
    const statement = containingStatement(node)
    if (statement == null) continue
    const selfType = typeContractSelfTypeText(node, source.sourceFile)
    if (selfType == null) continue
    const blocks = result.templates.flatMap(template => declarationTypeCheckBlock(source, template, selfType))
    if (blocks.length === 0) continue
    edits.push({start: statement.end, end: statement.end, blocks})
  }
  return edits
}

function declarationTypeCheckBlock(source: TypeCheckSource, template: TypeContractTemplate, selfType: string): GeneratedBlock[] {
  const selfName = `__fit_type_self_${nextGeneratedId()}`
  const spec = instantiateTypeContractTemplateForCheck(template, selfName)
  const statements = statementsForSpec(spec, lowerOptions(source))
  if (statements.length === 0) return []
  return [blockForEntry({
    sourceFile: source.sourceFile,
    file: source.file,
    functionName: '<type>',
    text: `type @fit ${template.text}`,
    ...(template.typeCheckKey == null ? {} : {key: template.typeCheckKey}),
    ...(template.line == null ? {} : {line: template.line}),
  }, [
    `const ${selfName} = null! as ${selfType}; void ${selfName};`,
    ...statements,
  ])]
}

function buildEditedSource(sourceText: string, edits: Edit[]): {text: string; spans: Span[]} {
  const sorted = edits
    .filter(edit => edit.blocks.length > 0 || edit.replacementSuffix != null)
    .sort((left, right) => left.start - right.start || left.end - right.end)
  let cursor = 0
  let text = ''
  const spans: Span[] = []
  for (const edit of sorted) {
    if (edit.start < cursor) continue
    text += sourceText.slice(cursor, edit.start)
    const editStart = text.length
    let offset = 0
    for (const block of edit.blocks) {
      text += block.text
      spans.push({...block.entry, start: editStart + offset, end: editStart + offset + block.text.length})
      offset += block.text.length
    }
    if (edit.replacementSuffix != null) text += edit.replacementSuffix
    cursor = edit.end
  }
  text += sourceText.slice(cursor)
  return {text, spans}
}

function typeContractSelfTypeText(node: ts.Node, sourceFile: ts.SourceFile): string | null {
  const scope = typeContractSelfScope(node)
  if (scope == null) return null
  if (ts.isInterfaceDeclaration(scope) || ts.isTypeAliasDeclaration(scope)) {
    return typeDeclarationReferenceText(scope)
  }
  return printTypeNode(scope, sourceFile)
}

function typeContractSelfScope(node: ts.Node): ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.TypeLiteralNode | null {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isTypeLiteralNode(node)) return node
  let current: ts.Node | undefined = node.parent
  while (current != null) {
    if (ts.isTypeLiteralNode(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) return current
    current = current.parent
  }
  return null
}

function typeDeclarationReferenceText(node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration) {
  const typeArguments = node.typeParameters?.map(() => 'any').join(', ')
  return typeArguments == null || typeArguments.length === 0 ? node.name.text : `${node.name.text}<${typeArguments}>`
}

function printTypeNode(node: ts.TypeNode, sourceFile: ts.SourceFile) {
  return typePrinter.printNode(ts.EmitHint.Unspecified, node, sourceFile)
}

function returnContextType(fn: FitFunction, sourceFile: ts.SourceFile): string | null {
  const type = fn.node.type
  if (type == null || ts.isTypePredicateNode(type)) return null
  return type.getText(sourceFile)
}

function contextualReturnExpression(expression: string, returnType: string | null) {
  return returnType == null ? `(${expression})` : `((${expression}) satisfies ${returnType})`
}

function blocksForSpecs(program: Program, functionName: string, specs: FitSpec[], options: LowerOptions): GeneratedBlock[] {
  return specs.flatMap(spec => {
    if (spec.typeCheckKey != null) {
      if (spec.typeCheckSourceId != null) options.typeContractSourceIds?.add(spec.typeCheckSourceId)
      return []
    }
    const statements = statementsForSpec(spec, options)
    if (statements.length === 0) return []
    return [blockForEntry({
      key: specKey(spec),
      sourceFile: program.sourceFile,
      file: program.file,
      functionName,
      text: spec.text,
      ...(spec.line == null ? {} : {line: spec.line}),
    }, statements)]
  })
}

function blocksForInlineTemplates(
  program: Program,
  functionName: string,
  templates: FitInlineSpecTemplate[],
  valueText: string,
): GeneratedBlock[] {
  return templates.flatMap(template => {
    const id = nextGeneratedId()
    const options = lowerOptions(program)
    const statements: string[] = []
    if (template.kind === 'range') {
      const target = checkNumberExpression(valueText, options, `${id}_value`)
      statements.push(...target.prelude, target.statement, ...rangeBoundStatements(template.range, options, id))
    } else if (template.op === '==') {
      const right = lowerExpression(template.right, options)
      statements.push(
        ...right.prelude,
        checkedConst(`${id}_comparison`, 'boolean', `${lowerRawExpressionText(valueText, options)} == ${right.expression}`),
      )
    } else {
      const target = checkNumberExpression(valueText, options, `${id}_value`)
      const right = checkNumberExpression(template.right, options, `${id}_right`)
      statements.push(...target.prelude, target.statement, ...right.prelude, right.statement)
    }
    return [blockForEntry({
      key: inlineTemplateKey(template),
      sourceFile: program.sourceFile,
      file: program.file,
      functionName,
      text: `@fit ${inlineTemplateText(template)}`,
      ...(template.line == null ? {} : {line: template.line}),
    }, statements)]
  })
}

function blockForEntry(entry: ContractTypeCheckEntry, statements: string[]): GeneratedBlock {
  const needsFitNumberType = statements.some(statement => statement.includes(fitNumberTypeName))
  return {
    entry,
    text: [
      '\n{',
      ...(needsFitNumberType ? [`type ${fitNumberTypeName}<T extends string> = T extends string ? number : never;`] : []),
      ...statements,
      '}',
    ].join('\n') + '\n',
  }
}

function statementsForSpec(spec: FitSpec, options: LowerOptions): string[] {
  const id = nextGeneratedId()
  switch (spec.kind) {
    case 'range': {
      const target = checkNumberExpression(spec.expression, options, `${id}_value`)
      return [...target.prelude, target.statement, ...rangeBoundStatements(spec.range, options, id)]
    }
    case 'comparison': {
      if (spec.op === '==') {
        const left = lowerExpression(spec.left, options)
        const right = lowerExpression(spec.right, options)
        return [
          ...left.prelude,
          ...right.prelude,
          checkedConst(`${id}_comparison`, 'boolean', `${left.expression} == ${right.expression}`),
        ]
      }
      const left = checkNumberExpression(spec.left, options, `${id}_left`)
      const right = checkNumberExpression(spec.right, options, `${id}_right`)
      return [...left.prelude, left.statement, ...right.prelude, right.statement]
    }
    case 'expression': {
      const expression = lowerExpression(spec.expression, options)
      return [
        ...expression.prelude,
        checkedConst(`${id}_bool`, 'boolean', expression.expression),
      ]
    }
    case 'value': {
      const expression = lowerExpression(spec.expression, options)
      const rangeExpressions = fitValueSpecExpressions(spec.value)
      return [
        ...expression.prelude,
        checkedConst(`${id}_value`, spec.value.typeText, expression.expression),
        ...rangeExpressions.flatMap((rangeExpression, index) => {
          const bound = checkNumberExpression(rangeExpression, options, `${id}_range_${index}`)
          return [...bound.prelude, bound.statement]
        }),
      ]
    }
  }
}

function rangeBoundStatements(range: FitRange, options: LowerOptions, id: string): string[] {
  return fitRangeCases(range).flatMap((rangeCase, index) => {
    const lower = checkNumberExpression(rangeCase.lower, options, `${id}_lower_${index}`)
    const upper = checkNumberExpression(rangeCase.upper, options, `${id}_upper_${index}`)
    return [...lower.prelude, lower.statement, ...upper.prelude, upper.statement]
  })
}

function checkNumberExpression(expression: FitExpressionLike, options: LowerOptions, name: string): LoweredExpression & {statement: string} {
  const lowered = lowerExpression(expression, options)
  return {
    ...lowered,
    statement: checkedConst(name, 'number', lowered.expression),
  }
}

function lowerExpression(expression: FitExpressionLike, options: LowerOptions): LoweredExpression {
  if (expressionHasDeclarationOnlyScope(expression, options.program)) return {expression: '0', prelude: []}
  const parsed = fitExpressionParsed(expression)
  const builtin = loweredBuiltinExpression(parsed.expression, options)
  if (builtin != null) return builtin
  return {
    expression: lowerFitExpressionText(fitExpressionText(expression), expression, options),
    prelude: [],
  }
}

function loweredBuiltinExpression(expression: ts.Expression, options: LowerOptions): LoweredExpression | null {
  const unwrapped = unwrapExpression(expression)
  if (!ts.isCallExpression(unwrapped)) return null
  const target = unwrapExpression(unwrapped.expression)
  if (!ts.isIdentifier(target) || !builtinNames.has(target.text)) return null
  const id = nextGeneratedId()
  switch (target.text) {
    case 'nondecreasing': {
      const arg = unwrapped.arguments[0]
      if (arg == null || unwrapped.arguments.length !== 1) return {expression: 'true', prelude: [checkedConst(`${id}_arity`, 'never', 'undefined')]}
      return {
        expression: 'true',
        prelude: sequencePropStatements(arg, options, id),
      }
    }
    case 'spaced': {
      const rows = unwrapped.arguments[0]
      const gap = unwrapped.arguments[1]
      if (rows == null || gap == null || unwrapped.arguments.length !== 2) return {expression: 'true', prelude: [checkedConst(`${id}_arity`, 'never', 'undefined')]}
      return {
        expression: 'true',
        prelude: [
          checkedConst(`${id}_rows`, 'readonly unknown[]', lowerRawExpressionText(rows.getText(), options)),
          checkedConst(`${id}_gap`, 'number', lowerRawExpressionText(gap.getText(), options)),
          checkedConst(`${id}_top`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.top`),
          checkedConst(`${id}_height`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.height`),
        ],
      }
    }
    case 'noOverlap': {
      const rows = unwrapped.arguments[0]
      if (rows == null || unwrapped.arguments.length !== 1) return {expression: 'true', prelude: [checkedConst(`${id}_arity`, 'never', 'undefined')]}
      return {
        expression: 'true',
        prelude: [checkedConst(`${id}_rows`, 'readonly unknown[]', lowerRawExpressionText(rows.getText(), options))],
      }
    }
    case 'lastEnd': {
      const rows = unwrapped.arguments[0]
      if (rows == null || unwrapped.arguments.length !== 1) return {expression: '0', prelude: [checkedConst(`${id}_arity`, 'never', 'undefined')]}
      return {
        expression: '0',
        prelude: [
          checkedConst(`${id}_rows`, 'readonly unknown[]', lowerRawExpressionText(rows.getText(), options)),
          checkedConst(`${id}_top`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.top`),
          checkedConst(`${id}_height`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.height`),
        ],
      }
    }
    case 'extentEnd': {
      const rows = unwrapped.arguments[0]
      const empty = unwrapped.arguments[1]
      if (rows == null || empty == null || unwrapped.arguments.length !== 2) return {expression: '0', prelude: [checkedConst(`${id}_arity`, 'never', 'undefined')]}
      return {
        expression: '0',
        prelude: [
          checkedConst(`${id}_rows`, 'readonly unknown[]', lowerRawExpressionText(rows.getText(), options)),
          checkedConst(`${id}_empty`, 'number', lowerRawExpressionText(empty.getText(), options)),
          checkedConst(`${id}_top`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.top`),
          checkedConst(`${id}_height`, 'number', `${lowerRawExpressionText(rows.getText(), options)}[0]!.height`),
        ],
      }
    }
  }
  return null
}

function sequencePropStatements(expression: ts.Expression, options: LowerOptions, id: string): string[] {
  const path = sequencePropPath(expression)
  if (path == null) return [checkedConst(`${id}_arg`, 'readonly unknown[]', lowerRawExpressionText(expression.getText(), options))]
  const array = lowerRawExpressionText(path.arrayText, options)
  const prop = path.props.map(propName => `.${propName}`).join('')
  return [
    checkedConst(`${id}_array`, 'readonly unknown[]', array),
    checkedConst(`${id}_prop`, 'number', `${array}[0]!${prop}`),
  ]
}

function sequencePropPath(expression: ts.Expression): {arrayText: string; props: string[]} | null {
  const props: string[] = []
  let current = unwrapExpression(expression)
  while (ts.isPropertyAccessExpression(current)) {
    props.unshift(current.name.text)
    current = unwrapExpression(current.expression)
  }
  if (props.length === 0) return null
  if (props.length === 1) return {arrayText: current.getText(), props}
  return {arrayText: `${current.getText()}.${props[0]!}`, props: props.slice(1)}
}

function checkedConst(name: string, typeText: string, expression: string): string {
  const variable = `__fit_typecheck_${name}`
  return `const ${variable}: ${typeText} = ${expression}; void ${variable};`
}

function lowerFitExpressionText(text: string, expression: FitExpressionLike, options: LowerOptions): string {
  let result = text
  for (const domainPath of [...fitExpressionParsed(expression).domainPaths.values()].sort((left, right) => domainPathText(right).length - domainPathText(left).length)) {
    result = replaceAll(result, domainPathText(domainPath), lowerDomainPath(domainPath, options))
  }
  return lowerRawExpressionText(result, options)
}

function lowerRawExpressionText(text: string, options: LowerOptions): string {
  return text
    .replace(new RegExp(`(?<![\\w$.])${fitReturnInternalRoot}(?![\\w$])`, 'g'), options.returnName)
    .replace(domainPathPattern, match => {
      const domainPath = parseDomainPathText(match)
      return domainPath == null ? match : lowerDomainPath(domainPath, options)
    })
}

function lowerDomainPath(domainPath: FitDomainPath, options: LowerOptions): string {
  let text = domainPath.root === fitReturnInternalRoot ? options.returnName : domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') text += `.${segment.name}`
    else text += '[0]!'
  }
  return text
}

function domainPathText(domainPath: FitDomainPath) {
  let text = domainPath.root
  for (const segment of domainPath.segments) {
    if (segment.kind === 'prop') {
      text += `.${segment.name}`
    } else {
      text += domainPathItemText(segment)
    }
  }
  return text
}

function domainPathItemText(segment: Extract<FitDomainPathSegment, {kind: 'item'}>) {
  if (segment.label == null || segment.offset == null) return '[]'
  if (segment.offset === 0) return `[${segment.label}]`
  return `[${segment.label} ${segment.offset < 0 ? '-' : '+'} ${Math.abs(segment.offset)}]`
}

function specMentionsReturn(spec: FitSpec): boolean {
  return specExpressionTexts(spec).some(expression => fitExpressionText(expression).includes(fitReturnInternalRoot))
}

function specExpressionTexts(spec: FitSpec): FitExpressionLike[] {
  switch (spec.kind) {
    case 'range':
      return [spec.expression]
    case 'value':
      return [spec.expression, ...fitValueSpecExpressions(spec.value)]
    case 'comparison':
      return [spec.left, spec.right]
    case 'expression':
      return [spec.expression]
  }
}

function specKey(spec: FitSpec) {
  if (spec.typeCheckKey != null) return spec.typeCheckKey
  return `${spec.line ?? ''}\0${spec.role}\0${spec.kind}\0${spec.text}`
}

function inlineTemplateKey(template: FitInlineSpecTemplate) {
  return `${template.line ?? ''}\0inline\0${template.kind}\0${inlineTemplateText(template)}`
}

function inlineTemplateText(template: FitInlineSpecTemplate) {
  return template.kind === 'range' ? template.range.text : `${template.op} ${template.right.text}`
}

function lowerOptions(program: TypeCheckSource, typeContractSourceIds?: Set<string>): LowerOptions {
  return {program, returnName: returnValueName, ...(typeContractSourceIds == null ? {} : {typeContractSourceIds})}
}

function expressionHasDeclarationOnlyScope(expression: FitExpressionLike, program: TypeCheckSource) {
  const scopeSourceId = fitExpressionScopeSourceId(expression)
  return scopeSourceId != null
    && scopeSourceId !== program.sourceId
    && fitExpressionParsed(expression).domainPaths.size === 0
}

function checksFromDiagnostics(diagnostics: readonly ts.Diagnostic[], spans: Span[]): ContractTypeCheckResult {
  const diagnosticsBySpan = new Map<Span, ts.Diagnostic[]>()
  for (const diagnostic of diagnostics) {
    if (diagnostic.start == null) continue
    const span = spans.find(current => diagnostic.start! >= current.start && diagnostic.start! <= current.end)
    if (span == null) continue
    const list = diagnosticsBySpan.get(span) ?? []
    list.push(diagnostic)
    diagnosticsBySpan.set(span, list)
  }

  const failedKeys = new Set<string>()
  const checks: FitCheck[] = []
  const seenChecks = new Set<string>()
  for (const [span, spanDiagnostics] of diagnosticsBySpan) {
    if (span.ignore === true) continue
    if (span.key != null) failedKeys.add(span.key)
    const reason = typeCheckReason(spanDiagnostics, span)
    const key = `${span.functionName}\0${span.line ?? ''}\0${span.text}\0${reason}`
    if (seenChecks.has(key)) continue
    seenChecks.add(key)
    checks.push({
      file: span.file,
      ...(span.line == null ? {} : {line: span.line}),
      functionName: span.functionName,
      text: span.text,
      status: 'unknown',
      reason,
    })
  }
  return {checks, failedKeys}
}

function typeCheckReason(diagnostics: readonly ts.Diagnostic[], span: Span) {
  const formatted = formatTypeScriptDiagnostics(diagnostics.map(diagnostic => contractDiagnosticForSpan(diagnostic, span)))
  return formatted.length === 0 ? 'TypeScript rejected @fit contract' : `TypeScript rejected @fit contract:\n${formatted}`
}

function contractDiagnosticForSpan(diagnostic: ts.Diagnostic, span: Span): ts.Diagnostic {
  const location = contractDiagnosticLocation(span)
  if (location == null) return diagnostic
  return {
    file: span.sourceFile,
    start: location.start,
    length: location.length,
    category: diagnostic.category,
    code: diagnostic.code,
    messageText: diagnostic.messageText,
  }
}

function contractDiagnosticLocation(span: Span): {start: number; length: number} | null {
  if (span.line == null) return null
  const lineIndex = span.line - 1
  const lineStarts = span.sourceFile.getLineStarts()
  if (lineIndex < 0 || lineIndex >= lineStarts.length) return null
  const lineStart = lineStarts[lineIndex]!
  const lineEnd = span.sourceFile.getLineEndOfPosition(lineStart)
  const lineText = span.sourceFile.text.slice(lineStart, lineEnd)
  const exactIndex = lineText.indexOf(span.text)
  if (exactIndex >= 0) return {start: lineStart + exactIndex, length: Math.max(1, span.text.length)}
  const fitIndex = lineText.indexOf('@fit')
  if (fitIndex >= 0) return {start: lineStart + fitIndex, length: Math.max(1, lineEnd - lineStart - fitIndex)}
  const nonWhitespaceIndex = /\S/.exec(lineText)?.index ?? 0
  return {start: lineStart + nonWhitespaceIndex, length: Math.max(1, lineEnd - lineStart - nonWhitespaceIndex)}
}

function returnStatementsIn(body: ts.Block): ts.ReturnStatement[] {
  const result: ts.ReturnStatement[] = []
  const visit = (node: ts.Node) => {
    if (node !== body && isFunctionLikeWithBody(node)) return
    if (ts.isReturnStatement(node)) {
      result.push(node)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(body)
  return result
}

function isFunctionLikeWithBody(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
}

function containingStatement(node: ts.Node): ts.Statement | null {
  let current: ts.Node | undefined = node
  while (current != null) {
    if (ts.isStatement(current)) return current
    current = current.parent
  }
  return null
}

function propertyValueExpressionText(property: ts.PropertyAssignment | ts.ShorthandPropertyAssignment, sourceFile: ts.SourceFile): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text
  return property.initializer.getText(sourceFile)
}

function lineNumberForNode(sourceFile: ts.SourceFile, node: ts.Node) {
  const nodeSourceFile = node.getSourceFile() ?? sourceFile
  return nodeSourceFile.getLineAndCharacterOfPosition(node.getStart(nodeSourceFile)).line + 1
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression
  }
  return current
}

function replaceAll(text: string, search: string, replacement: string) {
  return text.split(search).join(replacement)
}

function nextGeneratedId() {
  generatedId++
  return String(generatedId)
}

function scriptKindForVirtualSource(file: string): ts.ScriptKind {
  return file.endsWith('.tsx') || file.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

function virtualTypeCheckSourceId(sourceId: string) {
  if (sourceId.endsWith('.tsx') || sourceId.endsWith('.jsx')) return `${sourceId}.fit.tsx`
  return `${sourceId}.fit.ts`
}

function virtualRootNames(rootNames: string[], virtuals: VirtualTypeCheckSource[]) {
  const virtualByOriginal = new Map(virtuals.map(virtual => [virtual.originalSourceId, virtual.virtualSourceId]))
  const roots = rootNames.map(rootName => virtualByOriginal.get(normalizePath(rootName)) ?? rootName)
  const present = new Set(roots.map(normalizePath))
  for (const virtual of virtuals) {
    if (present.has(virtual.virtualSourceId)) continue
    present.add(virtual.virtualSourceId)
    roots.push(virtual.virtualSourceId)
  }
  return roots
}

function normalizePath(file: string) {
  return file.replace(/\\/g, '/')
}
