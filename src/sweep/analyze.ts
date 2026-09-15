// Run in the parent only: builds the sweep's entries from the TypeScript program `fr` already checked. Every named top-level
// function of the analyzed file is an entry (function declarations and `const f = (…) => …`), exported or not; its
// parameters' types become domains, narrowed by leading console.assert shapes.
//
// Ported from mutation-instrument-spike at bccf0dd (mutation-instrument/analyze.ts): the type classifier `classify` (depth 8),
// the leading-assert parser (`applyCondition`, `conjuncts`) and domain@v2 rules 1-3, unchanged:
//   1 a leading assert `a && b` narrows through each conjunct
//   2 callee substitution: for an unconditional call to a same-file function whose arguments are entry parameter paths,
//     the callee's leading asserts narrow the entry's domain
//   3 leak rule: a same-file callee's leading assert whose referenced parameters receive entry parameter paths at every
//     call from the entry discards the input when it fails
// New here (FREERANGE_SWEEP_FILTERS=default; `base` applies none of them):
//   F1 loop-scoped preconditions: at most 8 consecutive `for (let i = 0; i < P.length; i++)` or `for (const x of P)`
//      statements directly after the leading prefix, P an entry parameter path, whose bodies hold only console.assert
//      statements over entry parameters, the loop variable and constants. Their asserts discard.
//   F2 array-length ties: a leading `A.length === B.length` between two array parameter paths draws one length for both.
//   F3 the leak rule extended to direct element reads inside a loop over P (`P[i]`, `P[i]!`, `P[i].f`, or an alias
//      `const x = P[i]` / `const x = P[i]!` / `for (const x of P)` followed by `x` or `x.f`), transitively through same-file
//      callees up to 4 levels, where each level passes such reads or parameter paths. A derived argument such as
//      `job.width * 3` is not a read, so its callee requirement stays a call-site check.
import * as ts from 'typescript'
import {applyBound, applyIntegerRule, MAX_ARRAY_LENGTH, unboundedNumber, type Comparison, type Domain, type NumberDomain, type TupleDomain} from './domain.ts'
import {numberLeaves} from './lattice.ts'
import type {DiscardCause, Path, RelationPlan} from './types.ts'

export const F1_MAX_LOOPS = 8
export const F3_MAX_DEPTH = 4

// Positions are 1-based, as instrument.ts records sites.
export type AssertPosition = {line: number; column: number; cause: DiscardCause}
export type AnalyzedEntry = {
  name: string
  ordinal: number
  line: number
  parameterNames: string[]
  args: TupleDomain
  relations: RelationPlan[]
  lengthTies: [Path, Path][]
  unsupported: string | null
  discardAsserts: AssertPosition[] // leak (rule 3), F1 and F3 asserts; the entry's own leading asserts come from the sites
}
export type SweepFilters = 'base' | 'default'

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

// -- Types to domains (ported) ------------------------------------------------

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

// -- Leading assert shapes (ported) -------------------------------------------

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
function applyCondition(checker: ts.TypeChecker, condition: ts.Expression, bindings: Map<string, Path>, args: TupleDomain, relations: RelationPlan[]): 'bound' | 'integer' | 'finite' | 'relation' | 'unparsed' {
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

// -- Functions (ported) -------------------------------------------------------

type FunctionLike = ts.SignatureDeclaration & {body?: ts.ConciseBody | undefined}
type NamedFunction = {name: string; node: FunctionLike}

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

/** Every top-level function of the file, exported or not, by the declaration node its name resolves to, in source order. */
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

function positionOf(sourceFile: ts.SourceFile, node: ts.Node, cause: DiscardCause): AssertPosition {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return {line: position.line + 1, column: position.character + 1, cause}
}

// -- F1: loop-scoped preconditions ------------------------------------------------

/** `P` of `i < P.length`, `P[i]` or `for (const x of P)`, when P is rooted in one of `names`. */
function isRootedIn(node: ts.Expression, names: ReadonlySet<string>): boolean {
  const expression = unwrap(node)
  if (ts.isIdentifier(expression)) return names.has(expression.text)
  if (ts.isNonNullExpression(expression)) return isRootedIn(expression.expression, names)
  if (ts.isPropertyAccessExpression(expression)) return isRootedIn(expression.expression, names)
  if (ts.isElementAccessExpression(expression) && ts.isNumericLiteral(expression.argumentExpression)) return isRootedIn(expression.expression, names)
  return false
}

/** The loop variable and the array expression of `for (let i = 0; i < P.length; i++)` or `for (const x of P)`. */
function loopOverParameter(statement: ts.Statement, names: ReadonlySet<string>): {variable: string; kind: 'index' | 'element'; array: ts.Expression} | null {
  if (ts.isForOfStatement(statement) && statement.awaitModifier == null && ts.isVariableDeclarationList(statement.initializer)
    && statement.initializer.declarations.length === 1 && ts.isIdentifier(statement.initializer.declarations[0]!.name) && isRootedIn(statement.expression, names)) {
    return {variable: statement.initializer.declarations[0]!.name.text, kind: 'element', array: statement.expression}
  }
  if (!ts.isForStatement(statement) || statement.initializer == null || !ts.isVariableDeclarationList(statement.initializer)) return null
  const declarations = statement.initializer.declarations
  if (declarations.length !== 1 || !ts.isIdentifier(declarations[0]!.name) || declarations[0]!.initializer == null) return null
  const variable = declarations[0]!.name.text
  const initial = declarations[0]!.initializer
  if (!ts.isNumericLiteral(initial) || initial.text !== '0') return null
  const condition = statement.condition
  if (condition == null || !ts.isBinaryExpression(condition) || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null
  if (!ts.isIdentifier(condition.left) || condition.left.text !== variable) return null
  const lengthRead = unwrap(condition.right)
  if (!ts.isPropertyAccessExpression(lengthRead) || lengthRead.name.text !== 'length' || !isRootedIn(lengthRead.expression, names)) return null
  const increment = statement.incrementor
  const increments = increment != null && (
    ((ts.isPostfixUnaryExpression(increment) || ts.isPrefixUnaryExpression(increment)) && increment.operator === ts.SyntaxKind.PlusPlusToken
      && ts.isIdentifier(increment.operand) && increment.operand.text === variable)
    || (ts.isBinaryExpression(increment) && increment.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken && ts.isIdentifier(increment.left)
      && increment.left.text === variable && ts.isNumericLiteral(increment.right) && increment.right.text === '1'))
  return increments ? {variable, kind: 'index', array: lengthRead.expression} : null
}

const GLOBAL_CONSTANTS = new Set(['Number', 'Math', 'undefined', 'Infinity', 'NaN'])

/** Whether every free identifier of `condition` is an entry parameter, the loop variable, a `const` or a numeric global. */
function onlyParametersAndConstants(checker: ts.TypeChecker, condition: ts.Expression, allowed: ReadonlySet<string>): boolean {
  let ok = true
  const visit = (node: ts.Node): void => {
    if (!ok) return
    if (ts.isIdentifier(node)) {
      const parent = node.parent
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return
      if (allowed.has(node.text) || GLOBAL_CONSTANTS.has(node.text)) return
      const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration
      const isConst = declaration != null && ts.isVariableDeclaration(declaration) && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent)
      if (!isConst) ok = false
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(condition)
  return ok
}

function loopScopedPreconditions(checker: ts.TypeChecker, sourceFile: ts.SourceFile, body: ts.Block, parameterNames: ReadonlySet<string>): AssertPosition[] {
  const result: AssertPosition[] = []
  const start = leadingAssertStatements(body).length
  for (let offset = 0; offset < F1_MAX_LOOPS && start + offset < body.statements.length; offset++) {
    const statement = body.statements[start + offset]!
    const loop = loopOverParameter(statement, parameterNames)
    if (loop == null || !(ts.isForStatement(statement) || ts.isForOfStatement(statement))) break
    const inner = ts.isBlock(statement.statement) ? [...statement.statement.statements] : [statement.statement]
    const allowed = new Set([...parameterNames, loop.variable])
    const asserts: ts.CallExpression[] = []
    for (const child of inner) {
      if (!ts.isExpressionStatement(child) || !isConsoleAssertCall(child.expression)) break
      const condition = child.expression.arguments[0]
      if (condition == null || child.expression.arguments.length !== 1 || !onlyParametersAndConstants(checker, condition, allowed)) break
      asserts.push(child.expression)
    }
    if (inner.length === 0 || asserts.length !== inner.length) break
    for (const call of asserts) result.push(positionOf(sourceFile, call, 'F1'))
  }
  return result
}

// -- Leak rule (rule 3) and F3 ----------------------------------------------------

/** Whether `identifier` is the index variable of an enclosing `for (let i = 0; i < E.length; i++)` with E the same text. */
function isLoopIndexOver(identifier: ts.Identifier, array: ts.Expression, names: ReadonlySet<string>, sourceFile: ts.SourceFile): boolean {
  const arrayText = unwrap(array).getText(sourceFile)
  for (let current: ts.Node = identifier.parent; !ts.isSourceFile(current) && !ts.isFunctionLike(current); current = current.parent) {
    if (!ts.isForStatement(current)) continue
    const loop = loopOverParameter(current, names)
    if (loop != null && loop.kind === 'index' && loop.variable === identifier.text && unwrap(loop.array).getText(sourceFile) === arrayText) return true
  }
  return false
}

/** `P[i]` or `P[i]!` inside a loop over P, P rooted in `names`. */
function isElementRead(node: ts.Expression, names: ReadonlySet<string>, sourceFile: ts.SourceFile): boolean {
  let expression = unwrap(node)
  if (ts.isNonNullExpression(expression)) expression = unwrap(expression.expression)
  return ts.isElementAccessExpression(expression) && ts.isIdentifier(expression.argumentExpression)
    && isRootedIn(expression.expression, names) && isLoopIndexOver(expression.argumentExpression, expression.expression, names, sourceFile)
}

/**
 * Whether an argument passes an input value straight through: a parameter path of `names` (rule 3), or under F3 a direct
 * element read inside a loop over such a path, or `x` / `x.f` for an alias `const x = P[i]` or `for (const x of P)`.
 */
function isPassThroughArgument(checker: ts.TypeChecker, sourceFile: ts.SourceFile, argument: ts.Expression, names: ReadonlySet<string>, reads: boolean): boolean {
  const expression = unwrap(argument)
  if (isRootedIn(expression, names)) return true
  if (!reads) return false
  let base = expression
  while (ts.isPropertyAccessExpression(base) || ts.isNonNullExpression(base)) base = unwrap(base.expression)
  if (isElementRead(base, names, sourceFile)) return true
  if (!ts.isIdentifier(base)) return false
  const declaration = checker.getSymbolAtLocation(base)?.valueDeclaration
  if (declaration == null || !ts.isVariableDeclaration(declaration) || !ts.isVariableDeclarationList(declaration.parent)) return false
  const list = declaration.parent
  if (ts.isForOfStatement(list.parent) && list.parent.initializer === list) return isRootedIn(list.parent.expression, names)
  return (list.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer != null && isElementRead(declaration.initializer, names, sourceFile)
}

function parameterIndices(node: FunctionLike): Map<string, number> {
  const parameterOf = new Map<string, number>()
  node.parameters.forEach((parameter, index) => {
    const names: string[] = []
    bindingNames(parameter.name, names)
    for (const name of names) parameterOf.set(name, index)
  })
  return parameterOf
}

/**
 * Callee leading asserts that discard for an entry: rule 3 (depth 1, parameter paths), and under F3 up to F3_MAX_DEPTH levels
 * with element reads. An assert discards only when its referenced parameters are passed through at every call reached from
 * the entry, so each assert's verdict is the AND over every visit.
 */
function leakAsserts(checker: ts.TypeChecker, sourceFile: ts.SourceFile, entry: NamedFunction, entryNames: ReadonlySet<string>, functions: Map<ts.Node, NamedFunction>, filters: SweepFilters): AssertPosition[] {
  const verdicts = new Map<ts.CallExpression, {discards: boolean; cause: DiscardCause}>()
  const maxDepth = filters === 'default' ? F3_MAX_DEPTH : 1
  const reads = filters === 'default'
  const visit = (fn: NamedFunction, names: ReadonlySet<string>, depth: number, stack: NamedFunction[]): void => {
    if (fn.node.body == null || !ts.isBlock(fn.node.body)) return
    const callsByCallee = new Map<NamedFunction, ts.CallExpression[]>()
    for (const call of allCalls(fn.node.body)) {
      const callee = calleeOf(checker, call, functions)
      if (callee == null || callee === entry || stack.includes(callee)) continue
      const calls = callsByCallee.get(callee) ?? []
      calls.push(call)
      callsByCallee.set(callee, calls)
    }
    for (const [callee, calls] of callsByCallee) {
      if (callee.node.body == null || !ts.isBlock(callee.node.body)) continue
      const parameterOf = parameterIndices(callee.node)
      const passed = (index: number, withReads: boolean) => calls.every((call) => !call.arguments.some(ts.isSpreadElement)
        && call.arguments[index] != null && isPassThroughArgument(checker, sourceFile, call.arguments[index], names, withReads))
      for (const statement of leadingAssertStatements(callee.node.body)) {
        const assertCall = statement.expression as ts.CallExpression
        const condition = assertCall.arguments[0]
        if (condition == null) continue
        const referenced = [...referencedParameters(condition, parameterOf)]
        if (referenced.length === 0) continue
        const byPaths = depth === 1 && referenced.every((index) => passed(index, false))
        const discards = byPaths || (reads && referenced.every((index) => passed(index, true)))
        const previous = verdicts.get(assertCall)
        const cause: DiscardCause = byPaths && (previous == null || previous.cause === 'leading') ? 'leading' : 'F3'
        verdicts.set(assertCall, {discards: (previous?.discards ?? true) && discards, cause})
      }
      if (depth >= maxDepth) continue
      const calleeNames = new Set<string>()
      for (const [name, index] of parameterOf) if (passed(index, reads)) calleeNames.add(name)
      if (calleeNames.size > 0) visit(callee, calleeNames, depth + 1, [...stack, callee])
    }
  }
  visit(entry, entryNames, 1, [entry])
  const result: AssertPosition[] = []
  for (const [call, verdict] of verdicts) if (verdict.discards) result.push(positionOf(sourceFile, call, verdict.cause))
  return result
}

// -- F2: array-length ties --------------------------------------------------------

function lengthTie(checker: ts.TypeChecker, condition: ts.Expression, bindings: Map<string, Path>, parameterTypes: (path: Path) => boolean): [Path, Path] | null {
  const expression = unwrap(condition)
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null
  const left = unwrap(expression.left)
  const right = unwrap(expression.right)
  if (!ts.isPropertyAccessExpression(left) || !ts.isPropertyAccessExpression(right) || left.name.text !== 'length' || right.name.text !== 'length') return null
  const leftPath = pathOf(left.expression, bindings)
  const rightPath = pathOf(right.expression, bindings)
  if (leftPath == null || rightPath == null || JSON.stringify(leftPath) === JSON.stringify(rightPath)) return null
  if (!checker.isArrayType(checker.getTypeAtLocation(left.expression)) || !checker.isArrayType(checker.getTypeAtLocation(right.expression))) return null
  return parameterTypes(leftPath) && parameterTypes(rightPath) ? [leftPath, rightPath] : null
}

/** Whether `path` names an array domain reached through records and tuples only, so the lattice gives it its own leaf. */
function isArrayLeaf(args: TupleDomain, path: Path): boolean {
  let domain: Domain = args
  for (const segment of path) {
    switch (domain.kind) {
      case 'tuple': {
        const element: Domain | undefined = typeof segment === 'number' ? domain.elements[segment] : undefined
        if (element == null) return false
        domain = element
        break
      }
      case 'record': {
        const field: {name: string; domain: Domain} | undefined = domain.fields.find((candidate) => candidate.name === segment)
        if (field == null) return false
        domain = field.domain
        break
      }
      case 'number': case 'choice': case 'array': case 'union': return false
    }
  }
  return domain.kind === 'array'
}

// -- Entries ----------------------------------------------------------------------

function analyzeFunction(checker: ts.TypeChecker, sourceFile: ts.SourceFile, fn: NamedFunction, ordinal: number, functions: Map<ts.Node, NamedFunction>, filters: SweepFilters): AnalyzedEntry {
  const node = fn.node
  const lineOf = (target: ts.Node) => sourceFile.getLineAndCharacterOfPosition(target.getStart(sourceFile)).line + 1
  const entry: AnalyzedEntry = {name: fn.name, ordinal, line: lineOf(node), parameterNames: [], args: {kind: 'tuple', elements: []}, relations: [], lengthTies: [], unsupported: null, discardAsserts: []}
  const bindings = new Map<string, Path>()
  for (const parameter of node.parameters) {
    if (parameter.dotDotDotToken != null) {
      entry.unsupported = 'a rest parameter'
      return entry
    }
    const classified = classify(checker, checker.getTypeAtLocation(parameter), parameter, 1)
    if (typeof classified === 'string') {
      entry.unsupported = `parameter ${parameter.name.getText(sourceFile)} has ${classified}`
      return entry
    }
    const omittable = parameter.questionToken != null || parameter.initializer != null
    entry.args.elements.push(omittable ? merge([classified, {kind: 'choice', values: [undefined]}]) : classified)
    entry.parameterNames.push(ts.isIdentifier(parameter.name) ? parameter.name.text : '{…}')
    collectBindings(parameter.name, [entry.args.elements.length - 1], bindings)
  }
  if (node.body == null || !ts.isBlock(node.body)) return entry
  const body = node.body
  for (const statement of leadingAssertStatements(body)) {
    const condition = (statement.expression as ts.CallExpression).arguments[0]
    if (condition == null) continue
    for (const conjunct of conjuncts(condition)) {
      applyCondition(checker, conjunct, bindings, entry.args, entry.relations)
      if (filters !== 'default') continue
      const tie = lengthTie(checker, conjunct, bindings, (path) => isArrayLeaf(entry.args, path))
      if (tie != null) entry.lengthTies.push(tie)
    }
  }

  // domain@v2 rule 2: callee substitution through unconditional pass-through calls, once per distinct argument mapping.
  const substituted = new Set<string>()
  for (const call of unconditionalCalls(body)) {
    const callee = calleeOf(checker, call, functions)
    if (callee == null || callee.name === fn.name || callee.node.body == null || !ts.isBlock(callee.node.body)) continue
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
      }
    }
  }

  const names = new Set(bindings.keys())
  entry.discardAsserts.push(...leakAsserts(checker, sourceFile, fn, names, functions, filters))
  if (filters === 'default') entry.discardAsserts.push(...loopScopedPreconditions(checker, sourceFile, body, names))
  return entry
}

/** Every named top-level function of the file in source order, numbered from 0. Number sides are still unbounded here. */
export function sweepEntries(program: ts.Program, sourceFile: ts.SourceFile, filters: SweepFilters): AnalyzedEntry[] {
  const checker = program.getTypeChecker()
  const functions = sameFileFunctions(sourceFile)
  const result: AnalyzedEntry[] = []
  for (const fn of functions.values()) result.push(analyzeFunction(checker, sourceFile, fn, result.length, functions, filters))
  return result
}

/** Whether a top-level statement carries `export`; the temp copies export every other entry (export@v1). */
export function hasExport(node: ts.Node) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
}
