// domain@v1b, run in the parent only: finds a file's exported functions, derives each parameter's domain from its
// TypeScript type, and narrows the domains with the simple shapes of the function's leading console.assert calls.
// Forked from the replay input-range prototype (analyze.ts). A side of a number that no leading assert bounds is capped
// at ±1e6 instead of every finite double.
import {dirname} from 'node:path'
import * as ts from 'typescript'
import {applyBound, applyIntegerRule, capUnboundedEnds, MAX_ARRAY_LENGTH, unboundedNumber, type Comparison, type Domain, type NumberDomain, type TupleDomain} from './domain.ts'
import {numberLeaves} from './lattice.ts'
import type {EntryPlan, Path, Precondition, PreconditionUse, RelationPlan} from './types.ts'

export type AnalyzedEntry = Omit<EntryPlan, 'phases' | 'digest'>

/** One program for all files, with the compiler options of the nearest tsconfig.json of the first file. */
export function loadProgram(files: string[]): ts.Program {
  const configPath = ts.findConfigFile(dirname(files[0]!), (path) => ts.sys.fileExists(path))
  let options: ts.CompilerOptions = {strict: true, target: ts.ScriptTarget.ES2022}
  if (configPath != null) options = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, (path) => ts.sys.readFile(path)).config, ts.sys, dirname(configPath)).options
  return ts.createProgram(files, {...options, noEmit: true})
}

export function isConsoleAssertCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'console' && node.expression.name.text === 'assert'
}

/** The maximal consecutive prefix of `console.assert(...)` statements at function entry. */
export function leadingAssertStatements(body: ts.Block): ts.ExpressionStatement[] {
  const result: ts.ExpressionStatement[] = []
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !isConsoleAssertCall(statement.expression)) break
    result.push(statement)
  }
  return result
}

// -- Types to domains -------------------------------------------------------

function merge(domains: Domain[]): Domain {
  const values: Domain[] = []
  const choices: (number | boolean | string | null | undefined)[] = []
  for (const domain of domains) {
    if (domain.kind === 'choice') choices.push(...domain.values)
    else if (domain.kind === 'union') values.push(...domain.members)
    else values.push(domain)
  }
  if (choices.length > 0) values.push({kind: 'choice', values: choices})
  return values.length === 1 ? values[0]! : {kind: 'union', members: values}
}

function classify(checker: ts.TypeChecker, type: ts.Type, node: ts.Node, depth: number): Domain | string {
  if (depth > 8) return 'a type nested deeper than 8 levels'
  const flags = type.flags
  if (flags & ts.TypeFlags.NumberLiteral) return {kind: 'choice', values: [(type as ts.NumberLiteralType).value]}
  if (flags & ts.TypeFlags.StringLiteral) return {kind: 'choice', values: [(type as ts.StringLiteralType).value]}
  if (flags & ts.TypeFlags.BooleanLiteral) return {kind: 'choice', values: [checker.typeToString(type) === 'true']}
  if (flags & ts.TypeFlags.Null) return {kind: 'choice', values: [null]}
  if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return {kind: 'choice', values: [undefined]}
  if (flags & ts.TypeFlags.Number) return unboundedNumber()
  if (flags & ts.TypeFlags.Union) {
    const members: Domain[] = []
    for (const member of (type as ts.UnionType).types) {
      const domain = classify(checker, member, node, depth + 1)
      if (typeof domain === 'string') return domain
      members.push(domain)
    }
    return merge(members)
  }
  // A branded number, e.g. `number & {__brand: 'px'}`, generates like a plain number.
  if (flags & ts.TypeFlags.Intersection && (type as ts.IntersectionType).types.some((member) => member.flags & ts.TypeFlags.Number)) return unboundedNumber()
  if (checker.isTupleType(type)) {
    const target = (type as ts.TupleTypeReference).target
    if (target.elementFlags.some((elementFlags) => elementFlags & (ts.ElementFlags.Optional | ts.ElementFlags.Variable))) return 'a tuple with optional or rest elements'
    const elements: Domain[] = []
    for (const argument of checker.getTypeArguments(type as ts.TypeReference)) {
      const domain = classify(checker, argument, node, depth + 1)
      if (typeof domain === 'string') return domain
      elements.push(domain)
    }
    return {kind: 'tuple', elements}
  }
  if (checker.isArrayType(type)) {
    const element = classify(checker, checker.getTypeArguments(type as ts.TypeReference)[0]!, node, depth + 1)
    return typeof element === 'string' ? element : {kind: 'array', element, maxLength: MAX_ARRAY_LENGTH}
  }
  if (flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) {
    if (type.getCallSignatures().length > 0) return `a function-typed value (${checker.typeToString(type)})`
    const fields: {name: string; domain: Domain}[] = []
    for (const property of checker.getPropertiesOfType(type)) {
      const domain = classify(checker, checker.getTypeOfSymbolAtLocation(property, node), node, depth + 1)
      if (typeof domain === 'string') return domain
      const optional = (property.flags & ts.SymbolFlags.Optional) !== 0
      fields.push({name: property.name, domain: optional ? merge([domain, {kind: 'choice', values: [undefined]}]) : domain})
    }
    return {kind: 'record', fields}
  }
  return `the type ${checker.typeToString(type)}`
}

// -- Leading assert shapes --------------------------------------------------

function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node
}

function pathOf(node: ts.Expression, bindings: Map<string, Path>): Path | null {
  const expression = unwrap(node)
  if (ts.isIdentifier(expression)) return bindings.get(expression.text) ?? null
  if (ts.isPropertyAccessExpression(expression)) {
    const base = pathOf(expression.expression, bindings)
    return base == null ? null : [...base, expression.name.text]
  }
  if (ts.isElementAccessExpression(expression) && ts.isNumericLiteral(expression.argumentExpression)) {
    const base = pathOf(expression.expression, bindings)
    return base == null ? null : [...base, Number(expression.argumentExpression.text)]
  }
  return null
}

/** A numeric literal, a negated one, or any expression whose type is one numeric literal, e.g. an imported `const GAP = 16`. */
function constantOf(checker: ts.TypeChecker, node: ts.Expression): number | null {
  const expression = unwrap(node)
  if (ts.isNumericLiteral(expression)) return Number(expression.text)
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(expression.operand)) return -Number(expression.operand.text)
  const type = checker.getTypeAtLocation(expression)
  return type.flags & ts.TypeFlags.NumberLiteral ? (type as ts.NumberLiteralType).value : null
}

const COMPARISONS = new Map<ts.SyntaxKind, Comparison>([
  [ts.SyntaxKind.LessThanToken, '<'], [ts.SyntaxKind.LessThanEqualsToken, '<='], [ts.SyntaxKind.GreaterThanToken, '>'],
  [ts.SyntaxKind.GreaterThanEqualsToken, '>='], [ts.SyntaxKind.EqualsEqualsEqualsToken, '==='], [ts.SyntaxKind.ExclamationEqualsEqualsToken, '!=='],
])
const FLIPPED: Record<Comparison, Comparison> = {'<': '>', '<=': '>=', '>': '<', '>=': '<=', '===': '===', '!==': '!=='}

/** Parses one condition, e.g. `x >= 0`, `Number.isInteger(x)`, or `a <= b`, and narrows `args` in place. */
function applyCondition(checker: ts.TypeChecker, condition: ts.Expression, bindings: Map<string, Path>, args: TupleDomain, relations: RelationPlan[]): PreconditionUse {
  const expression = unwrap(condition)
  if (ts.isCallExpression(expression) && expression.arguments.length === 1 && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === 'Number') {
    const path = pathOf(expression.arguments[0]!, bindings)
    const leaves = path == null ? [] : numberLeaves(args, path)
    if (leaves.length === 0) return 'unparsed'
    switch (expression.expression.name.text) {
      case 'isInteger':
        for (const leaf of leaves) applyIntegerRule(leaf)
        return 'integer'
      case 'isFinite': return 'finite'
      default: return 'unparsed'
    }
  }
  if (!ts.isBinaryExpression(expression)) return 'unparsed'
  const op = COMPARISONS.get(expression.operatorToken.kind)
  if (op == null) return 'unparsed'
  const leftPath = pathOf(expression.left, bindings)
  const rightPath = pathOf(expression.right, bindings)
  if (leftPath != null && rightPath != null) {
    if (numberLeaves(args, leftPath).length === 0 || numberLeaves(args, rightPath).length === 0 || op === '!==') return 'unparsed'
    relations.push({left: leftPath, op, right: rightPath})
    return 'relation'
  }
  const leftConstant = leftPath == null ? constantOf(checker, expression.left) : null
  const rightConstant = rightPath == null ? constantOf(checker, expression.right) : null
  const bound = leftPath != null && rightConstant != null ? {path: leftPath, op, constant: rightConstant}
    : rightPath != null && leftConstant != null ? {path: rightPath, op: FLIPPED[op], constant: leftConstant} : null
  if (bound == null) return 'unparsed'
  const leaves: NumberDomain[] = numberLeaves(args, bound.path)
  if (leaves.length === 0) return 'unparsed'
  for (const leaf of leaves) applyBound(leaf, bound.op, bound.constant)
  return 'bound'
}

// -- Functions --------------------------------------------------------------

function hasExport(node: ts.Node) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}

function collectBindings(name: ts.BindingName, path: Path, bindings: Map<string, Path>) {
  if (ts.isIdentifier(name)) {
    bindings.set(name.text, path)
    return
  }
  name.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return
    const key = ts.isObjectBindingPattern(name)
      ? element.propertyName != null && ts.isIdentifier(element.propertyName) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null
      : index
    if (key != null) collectBindings(element.name, [...path, key], bindings)
  })
}

function analyzeFunction(checker: ts.TypeChecker, sourceFile: ts.SourceFile, name: string, ordinal: number, node: ts.SignatureDeclaration & {body?: ts.ConciseBody | undefined}): AnalyzedEntry {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1
  const entry: AnalyzedEntry = {name, ordinal, line, parameterNames: [], args: {kind: 'tuple', elements: []}, relations: [], preconditions: [], unsupported: null}
  const bindings = new Map<string, Path>()
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken != null) {
      entry.unsupported = 'a rest parameter'
      return entry
    }
    const classified = classify(checker, checker.getTypeAtLocation(parameter), parameter, 1)
    if (typeof classified === 'string') {
      entry.unsupported = `parameter ${parameter.name.getText()} has ${classified}`
      return entry
    }
    const omittable = parameter.questionToken != null || parameter.initializer != null
    entry.args.elements.push(omittable ? merge([classified, {kind: 'choice', values: [undefined]}]) : classified)
    entry.parameterNames.push(ts.isIdentifier(parameter.name) ? parameter.name.text : '{…}')
    collectBindings(parameter.name, [entry.args.elements.length - 1], bindings)
  }
  if (node.body == null || !ts.isBlock(node.body)) return entry
  const preconditions: Precondition[] = []
  for (const statement of leadingAssertStatements(node.body)) {
    const call = statement.expression as ts.CallExpression
    const condition = call.arguments[0]
    const use = condition == null ? 'unparsed' : applyCondition(checker, condition, bindings, entry.args, entry.relations)
    preconditions.push({text: condition?.getText() ?? '', line: sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1, use})
  }
  entry.preconditions = preconditions
  return entry
}

/** Every exported function declaration and exported `const name = (...) => ...` of the file, in source order. */
export function exportedEntries(program: ts.Program, file: string): AnalyzedEntry[] {
  const sourceFile = program.getSourceFile(file)
  if (sourceFile == null) throw new Error(`TypeScript did not load ${file}`)
  const checker = program.getTypeChecker()
  const result: AnalyzedEntry[] = []
  for (const statement of sourceFile.statements) {
    if (!hasExport(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name != null) result.push(analyzeFunction(checker, sourceFile, statement.name.text, result.length, statement))
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          result.push(analyzeFunction(checker, sourceFile, declaration.name.text, result.length, initializer))
        }
      }
    }
  }
  // The cap goes last, after every leading assert has narrowed the domains, so a declared bound replaces the cap on its side.
  for (const entry of result) capUnboundedEnds(entry.args)
  return result
}
