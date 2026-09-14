// domain@v1b and domain@v2, run in the parent only: finds a file's exported functions, derives each parameter's domain from
// its TypeScript type, and narrows the domains with the simple shapes of leading console.assert calls. Forked from the replay
// input-range prototype (analyze.ts). The ±1e6 cap on sides no leading assert bounds is applied by run.ts, after the caller
// rules of domain@v3-callers (callers.ts).
// domain@v1b parses each of the entry's own leading asserts whole: `a && b` is one unparsed precondition, which still
// discards at run time. domain@v2 adds three rules to domain@v1b:
//   1 a leading assert `a && b` narrows through each conjunct
//   2 callee substitution: for an unconditional call to a same-file function whose arguments are entry parameter paths,
//     the callee's leading asserts are rewritten through the argument mapping and narrow the entry's domain, e.g.
//     `menuHoverContains(anchorCenter, exit, anchor, panel)` adds `anchor.width >= 0` to the caller's domain
//   3 leak rule: a same-file callee's leading assert whose referenced parameters receive entry parameter paths at every
//     call from the entry discards the input when it fires, like the entry's own leading asserts
import {dirname} from 'node:path'
import * as ts from 'typescript'
import {applyBound, applyIntegerRule, MAX_ARRAY_LENGTH, unboundedNumber, type Comparison, type Domain, type NumberDomain, type TupleDomain} from './domain.ts'
import {numberLeaves} from './lattice.ts'
import type {EntryPlan, Path, Precondition, PreconditionUse, RelationPlan} from './types.ts'

// Positions are 1-based, as instrument.ts records sites.
export type AssertPosition = {line: number; column: number}
export type AnalyzedEntry = Omit<EntryPlan, 'phases' | 'digest' | 'discardSites' | 'leakSites' | 'callerRules' | 'provenance'> & {leakAsserts: AssertPosition[]}

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

/** domain@v2 rule 1: `a && (b && c)` is the conjuncts a, b, c; any other condition is itself. */
function conjuncts(condition: ts.Expression): ts.Expression[] {
  const expression = unwrap(condition)
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return [...conjuncts(expression.left), ...conjuncts(expression.right)]
  return [condition]
}

// -- Functions --------------------------------------------------------------

type FunctionLike = ts.SignatureDeclaration & {body?: ts.ConciseBody | undefined}
type NamedFunction = {name: string; node: FunctionLike}

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

function bindingNames(name: ts.BindingName, output: string[]) {
  if (ts.isIdentifier(name)) {
    output.push(name.text)
    return
  }
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, output)
}

/** Every top-level function of the file, exported or not, by the declaration node its name resolves to. */
function sameFileFunctions(sourceFile: ts.SourceFile): Map<ts.Node, NamedFunction> {
  const result = new Map<ts.Node, NamedFunction>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name != null) result.set(statement, {name: statement.name.text, node: statement})
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          result.set(declaration, {name: declaration.name.text, node: initializer})
        }
      }
    }
  }
  return result
}

function calleeOf(checker: ts.TypeChecker, call: ts.CallExpression, functions: Map<ts.Node, NamedFunction>): NamedFunction | null {
  if (!ts.isIdentifier(call.expression)) return null
  const declaration = checker.getSymbolAtLocation(call.expression)?.valueDeclaration
  return declaration == null ? null : functions.get(declaration) ?? null
}

function containsExit(node: ts.Node): boolean {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return false
  if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true
  return ts.forEachChild(node, containsExit) === true
}

/**
 * Calls that run on every path through the body before any statement that can return or throw: calls inside top-level
 * expression, variable and return statements, excluding nested functions, the branches of `?:`, and the right side of
 * `&&`, `||` and `??`.
 */
function unconditionalCalls(body: ts.Block): ts.CallExpression[] {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isConditionalExpression(node)) {
      visit(node.condition)
      return
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind
      if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken
        || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken || kind === ts.SyntaxKind.BarBarEqualsToken || kind === ts.SyntaxKind.QuestionQuestionEqualsToken) {
        visit(node.left)
        return
      }
    }
    if (ts.isCallExpression(node)) result.push(node)
    ts.forEachChild(node, visit)
  }
  for (const statement of body.statements) {
    if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement) || ts.isReturnStatement(statement)) {
      visit(statement)
      if (ts.isReturnStatement(statement)) break
      continue
    }
    if (containsExit(statement)) break
  }
  return result
}

/** Every call in the body, on any path, excluding nested functions. */
function allCalls(body: ts.Block): ts.CallExpression[] {
  const result: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return
    if (ts.isCallExpression(node)) result.push(node)
    ts.forEachChild(node, visit)
  }
  for (const statement of body.statements) visit(statement)
  return result
}

/** Indices of the callee parameters that a condition references, e.g. {2, 3} for `anchor.width >= 0 && panel.height >= 0`. */
function referencedParameters(condition: ts.Expression, parameterOf: Map<string, number>): Set<number> {
  const result = new Set<number>()
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      if ((ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node)) return
      const index = parameterOf.get(node.text)
      if (index != null) result.add(index)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(condition)
  return result
}

function sameRelation(left: RelationPlan, right: RelationPlan) {
  return left.op === right.op && JSON.stringify(left.left) === JSON.stringify(right.left) && JSON.stringify(left.right) === JSON.stringify(right.right)
}

function analyzeFunction(checker: ts.TypeChecker, sourceFile: ts.SourceFile, file: string, name: string, ordinal: number, node: FunctionLike, functions: Map<ts.Node, NamedFunction>, v2Rules: boolean): AnalyzedEntry {
  const lineOf = (target: ts.Node) => sourceFile.getLineAndCharacterOfPosition(target.getStart()).line + 1
  const entry: AnalyzedEntry = {name, file, ordinal, line: lineOf(node), parameterNames: [], args: {kind: 'tuple', elements: []}, relations: [], preconditions: [], unsupported: null, leakAsserts: []}
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
  const body = node.body
  const preconditions: Precondition[] = []
  for (const statement of leadingAssertStatements(body)) {
    const call = statement.expression as ts.CallExpression
    const condition = call.arguments[0]
    if (condition == null) {
      preconditions.push({text: '', file, line: lineOf(call), use: 'unparsed', origin: 'entry', callee: null})
      continue
    }
    for (const conjunct of v2Rules ? conjuncts(condition) : [condition]) {
      preconditions.push({text: conjunct.getText(), file, line: lineOf(call), use: applyCondition(checker, conjunct, bindings, entry.args, entry.relations), origin: 'entry', callee: null})
    }
  }
  if (!v2Rules) {
    entry.preconditions = preconditions
    return entry
  }

  // domain@v2 rule 2: callee substitution through unconditional pass-through calls, once per distinct argument mapping.
  const substituted = new Set<string>()
  for (const call of unconditionalCalls(body)) {
    const callee = calleeOf(checker, call, functions)
    if (callee == null || callee.name === name || callee.node.body == null || !ts.isBlock(callee.node.body)) continue
    const calleeBindings = new Map<string, Path>()
    const mapping: (Path | null)[] = []
    callee.node.parameters.forEach((parameter, index) => {
      const argument = call.arguments[index]
      const path = argument == null || ts.isSpreadElement(argument) || call.arguments.slice(0, index).some(ts.isSpreadElement) ? null : pathOf(argument, bindings)
      mapping.push(path)
      if (path != null) collectBindings(parameter.name, path, calleeBindings)
    })
    const signature = `${callee.name}|${JSON.stringify(mapping)}`
    if (substituted.has(signature) || calleeBindings.size === 0) continue
    substituted.add(signature)
    for (const statement of leadingAssertStatements(callee.node.body)) {
      const condition = (statement.expression as ts.CallExpression).arguments[0]
      if (condition == null) continue
      for (const conjunct of conjuncts(condition)) {
        const before = entry.relations.length
        const use = applyCondition(checker, conjunct, calleeBindings, entry.args, entry.relations)
        if (use === 'relation' && entry.relations.length > before && entry.relations.slice(0, before).some((relation) => sameRelation(relation, entry.relations[before]!))) entry.relations.pop()
        preconditions.push({text: conjunct.getText(), file, line: lineOf(statement), use, origin: 'callee', callee: callee.name})
      }
    }
  }
  entry.preconditions = preconditions

  // domain@v2 rule 3: leak asserts, whose referenced callee parameters are entry parameter paths at every call.
  const callsByCallee = new Map<NamedFunction, ts.CallExpression[]>()
  for (const call of allCalls(body)) {
    const callee = calleeOf(checker, call, functions)
    if (callee == null || callee.name === name) continue
    const calls = callsByCallee.get(callee) ?? []
    calls.push(call)
    callsByCallee.set(callee, calls)
  }
  for (const [callee, calls] of callsByCallee) {
    if (callee.node.body == null || !ts.isBlock(callee.node.body)) continue
    const parameterOf = new Map<string, number>()
    callee.node.parameters.forEach((parameter, index) => {
      const names: string[] = []
      bindingNames(parameter.name, names)
      for (const bindingName of names) parameterOf.set(bindingName, index)
    })
    for (const statement of leadingAssertStatements(callee.node.body)) {
      const assertCall = statement.expression as ts.CallExpression
      const condition = assertCall.arguments[0]
      if (condition == null) continue
      const referenced = referencedParameters(condition, parameterOf)
      if (referenced.size === 0) continue
      const passThrough = calls.every((call) => !call.arguments.some(ts.isSpreadElement)
        && [...referenced].every((index) => call.arguments[index] != null && pathOf(call.arguments[index], bindings) != null))
      if (!passThrough) continue
      const position = sourceFile.getLineAndCharacterOfPosition(assertCall.getStart(sourceFile))
      entry.leakAsserts.push({line: position.line + 1, column: position.character + 1})
    }
  }
  return entry
}

/**
 * Every exported function declaration and exported `const name = (...) => ...` of the file, in source order, numbered
 * from `ordinalStart`. `file` is the logical file name the entries and their preconditions carry. A name in `excluded`
 * isn't an entry and takes no ordinal, e.g. tooltipContentLayout in m7's tooltip copy. `version` is the registered
 * domain.version: domain@v1b applies none of domain@v2's rules 1-3. Number sides that no leading assert bounds are still
 * unbounded here; run.ts applies the caller rules and then the cap.
 */
export function exportedEntries(program: ts.Program, path: string, file: string, ordinalStart: number, version: string, excluded: string[]): AnalyzedEntry[] {
  const sourceFile = program.getSourceFile(path)
  if (sourceFile == null) throw new Error(`TypeScript did not load ${path}`)
  const checker = program.getTypeChecker()
  const functions = sameFileFunctions(sourceFile)
  const v2Rules = version !== 'domain@v1b'
  const result: AnalyzedEntry[] = []
  const add = (name: string, node: FunctionLike) => {
    if (!excluded.includes(name)) result.push(analyzeFunction(checker, sourceFile, file, name, ordinalStart + result.length, node, functions, v2Rules))
  }
  for (const statement of sourceFile.statements) {
    if (!hasExport(statement)) continue
    if (ts.isFunctionDeclaration(statement) && statement.name != null) add(statement.name.text, statement)
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer
        if (ts.isIdentifier(declaration.name) && initializer != null && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) add(declaration.name.text, initializer)
      }
    }
  }
  return result
}
