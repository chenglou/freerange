import * as ts from 'typescript'
import type {ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {platformFact} from './platform.ts'
import {
  addInstruction,
  addSite,
  createBlock,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
} from './context.ts'

// The only entry point through which assignments lower. Statement positions (expression
// statements, for-loop incrementors) call this; everything else goes through
// lowerExpression, which rejects assignment forms — so an assignment used as a value
// inside a larger expression cannot lower by construction, and ternary/logical arms are
// provably assignment-free (their join carries exactly one parameter, the result).
export function lowerStatementExpression(expression: ts.Expression, context: FunctionContext): void {
  const current = unwrap(expression, context.checker)
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(current.left)
  ) {
    requireAccessedPropertyKind(current.left, context.checker)
    const object = lowerExpression(current.left.expression, context)
    const value = lowerExpression(current.right, context)
    addInstruction(context, current, {kind: 'store', object, property: current.left.name.text, value})
    return
  }
  const assignment = identifierAssignment(current)
  if (assignment != null) {
    const symbol = requiredSymbol(assignment.target, context.checker)
    switch (assignment.form) {
      case 'assign': {
        const moduleBinding = context.moduleBindingsBySymbol.get(symbol)
        if (!context.bindings.has(symbol) && moduleBinding == null) {
          throw unsupported(assignment.target, {kind: 'unknownIdentifier', name: assignment.target.text})
        }
        // Rebinding is only sound when the target's declared type holds a single value
        // kind — otherwise branches could bind different kinds that meet at a block join.
        // Function locals with mixed-kind declared types already stop at their declaration;
        // a module binding can still hold one (a top-level `let config: unknown`
        // initializes through the initializer's own declarator path), so for those the
        // write itself stops here. The checker returns the declared type at an assignment
        // target, not a narrowed one: narrowing does not apply to write positions.
        const targetType = context.checker.getTypeAtLocation(assignment.target)
        if (valueKind(targetType, context.checker) == null) {
          throw unsupported(assignment.target, {kind: 'valueType', typeText: context.checker.typeToString(targetType)})
        }
        const value = lowerExpression(assignment.node.right, context)
        assignIdentifier(symbol, assignment.target, value, current, context)
        return
      }
      case 'compound': {
        const left = identifierValue(symbol, assignment.target, context)
        const right = lowerExpression(assignment.node.right, context)
        const value = addInstruction(context, current, {kind: 'binary', operator: assignment.operator, left, right})
        assignIdentifier(symbol, assignment.target, value, current, context)
        return
      }
      case 'update': {
        // In statement position the expression's own value is discarded, so the prefix
        // versus postfix result distinction does not exist here.
        const previous = identifierValue(symbol, assignment.target, context)
        const one = addInstruction(context, current, {kind: 'constant', value: 1})
        const value = addInstruction(context, current, {
          kind: 'binary',
          operator: assignment.node.operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract',
          left: previous,
          right: one,
        })
        assignIdentifier(symbol, assignment.target, value, current, context)
        return
      }
    }
  }
  lowerExpression(expression, context)
}

export function lowerExpression(expression: ts.Expression, context: FunctionContext): ValueID {
  const current = unwrap(expression, context.checker)
  if (ts.isNumericLiteral(current)) {
    return addInstruction(context, current, {kind: 'constant', value: Number(current.text)})
  }
  if (current.kind === ts.SyntaxKind.TrueKeyword || current.kind === ts.SyntaxKind.FalseKeyword) {
    return addInstruction(context, current, {kind: 'booleanConstant', value: current.kind === ts.SyntaxKind.TrueKeyword})
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const zero = addInstruction(context, current, {kind: 'constant', value: 0})
    const value = lowerExpression(current.operand, context)
    return addInstruction(context, current, {kind: 'binary', operator: 'subtract', left: zero, right: value})
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    requireBooleanCondition(current.operand, context.checker)
    const value = lowerExpression(current.operand, context)
    return addInstruction(context, current, {kind: 'not', value})
  }
  if (ts.isConditionalExpression(current)) {
    return lowerConditionalExpression(current, context)
  }
  if (ts.isIdentifier(current)) {
    return identifierValue(requiredSymbol(current, context.checker), current, context)
  }
  if (ts.isObjectLiteralExpression(current)) {
    const properties = current.properties.map(property => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property)
        if (symbol == null) throw unsupported(property, {kind: 'missingSymbol'})
        return {name: property.name.text, value: identifierValue(symbol, property.name, context)}
      }
      if (ts.isPropertyAssignment(property)) {
        return {name: propertyName(property.name), value: lowerExpression(property.initializer, context)}
      }
      throw unsupported(property, {kind: 'objectPropertyForm'})
    })
    return addInstruction(context, current, {kind: 'object', properties})
  }
  if (ts.isBinaryExpression(current) && ts.isPropertyAccessExpression(current.left)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    throw unsupported(current, {kind: 'assignmentInValuePosition'})
  }
  if (identifierAssignment(current) != null) {
    throw unsupported(current, {kind: 'assignmentInValuePosition'})
  }
  if (
    ts.isBinaryExpression(current)
    && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return lowerLogicalExpression(current, context)
  }
  if (ts.isBinaryExpression(current)) {
    const arithmetic = arithmeticOperator(current.operatorToken.kind)
    const comparison = comparisonOperator(current.operatorToken.kind)
    if (arithmetic == null && comparison == null) {
      throw unsupported(current, {kind: 'binaryOperator', operator: current.operatorToken.getText(context.sourceFile)})
    }
    requireNumberType(current.left, context.checker)
    requireNumberType(current.right, context.checker)
    const left = lowerExpression(current.left, context)
    const right = lowerExpression(current.right, context)
    return arithmetic != null
      ? addInstruction(context, current, {kind: 'binary', operator: arithmetic, left, right})
      : addInstruction(context, current, {kind: 'compare', operator: comparison!, left, right})
  }
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(current.expression), context.checker)
      const callee = symbol == null ? undefined : context.functionsBySymbol.get(symbol)
      if (callee == null) throw unsupported(current, {kind: 'call', callee: current.expression.text})
      if (current.arguments.length < callee.declaration.parameters.length) {
        throw unsupported(current, {kind: 'callWithFewerArguments', callee: current.expression.text})
      }
      const arguments_ = current.arguments.map(argument => lowerExpression(argument, context))
      return addInstruction(context, current, {kind: 'call', function: callee.id, arguments: arguments_})
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const platformCall = current.arguments.length === 0 ? platformFact(current.expression, true, context.checker) : null
      if (platformCall != null) {
        return addInstruction(context, current, {kind: 'platformValue', ...platformCall})
      }
      const method = current.expression.name.text
      const standardMath = isStandardMathObject(current.expression.expression, context.checker)
      if (standardMath && method === 'floor' && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker)
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, current, {kind: 'floor', value})
      }
      if (standardMath && method === 'abs' && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker)
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, current, {kind: 'absolute', value})
      }
      if (standardMath && (method === 'min' || method === 'max') && current.arguments.length > 0) {
        for (const argument of current.arguments) requireNumberType(argument, context.checker)
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, current, {kind: method === 'min' ? 'minimum' : 'maximum', values})
      }
      throw unsupported(current, {kind: 'call', callee: current.expression.getText(context.sourceFile)})
    }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const platform = platformFact(current, false, context.checker)
    if (platform != null) {
      return addInstruction(context, current, {kind: 'platformValue', ...platform})
    }
    const objectType = context.checker.getTypeAtLocation(current.expression)
    if ((objectType.flags & ts.TypeFlags.Object) === 0) {
      throw unsupported(current.expression, {kind: 'propertyReadOnNonObject', typeText: context.checker.typeToString(objectType)})
    }
    requireAccessedPropertyKind(current, context.checker)
    const object = lowerExpression(current.expression, context)
    return addInstruction(context, current, {kind: 'property', object, property: current.name.text})
  }
  throw unsupported(current, {kind: 'expressionForm', syntax: ts.SyntaxKind[current.kind]})
}

// The single recognizer for the three forms that assign through a plain identifier. The
// lowering arms and the loop-carry detection in statements.ts both dispatch on this, so a
// new assigning form cannot lower without also being carried across loop back edges (a
// binding rebound in a loop body but not carried would silently analyze later iterations
// with the stale pre-loop value).
export type IdentifierAssignment =
  | {form: 'assign'; target: ts.Identifier; node: ts.BinaryExpression}
  | {form: 'compound'; target: ts.Identifier; node: ts.BinaryExpression; operator: Extract<InstructionIR, {kind: 'binary'}>['operator']}
  | {form: 'update'; target: ts.Identifier; node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression}

export function identifierAssignment(node: ts.Node): IdentifierAssignment | null {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return {form: 'assign', target: node.left, node}
    const operator = compoundAssignmentOperator(node.operatorToken.kind)
    if (operator != null) return {form: 'compound', target: node.left, node, operator}
  }
  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(node.operand)
  ) {
    return {form: 'update', target: node.operand, node}
  }
  return null
}

export function compoundAssignmentOperator(kind: ts.SyntaxKind): Extract<InstructionIR, {kind: 'binary'}>['operator'] | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken: return 'add'
    case ts.SyntaxKind.MinusEqualsToken: return 'subtract'
    case ts.SyntaxKind.AsteriskEqualsToken: return 'multiply'
    case ts.SyntaxKind.SlashEqualsToken: return 'divide'
    default: return null
  }
}

// The shared value-producing branch shape: branch on the condition, lower each arm in its
// own block, and join at a continuation whose single parameter carries the result. Arms are
// provably assignment-free — assignments lower only through lowerStatementExpression — so
// no bindings can change across the arms and the join needs no binding merge. Ternaries and
// the logical operators are the two consumers; lowerIfStatement stays separate (no result
// value, arms may terminate, and assignments are allowed there).
function lowerValueBranch(
  node: ts.Expression,
  condition: ValueID,
  lowerTrueArm: () => ValueID,
  lowerFalseArm: () => ValueID,
  context: FunctionContext,
): ValueID {
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
    site: addSite(context, node),
  })
  context.currentBlock = context.blocks[whenTrue]!
  const trueValue = lowerTrueArm()
  const trueBlock = context.currentBlock
  context.currentBlock = context.blocks[whenFalse]!
  const falseValue = lowerFalseArm()
  const falseBlock = context.currentBlock
  const continuation = createBlock(context, 1)
  terminate(trueBlock, {
    kind: 'jump',
    target: {block: continuation, arguments: [trueValue]},
    site: addSite(context, node),
  })
  terminate(falseBlock, {
    kind: 'jump',
    target: {block: continuation, arguments: [falseValue]},
    site: addSite(context, node),
  })
  context.currentBlock = context.blocks[continuation]!
  return context.currentBlock.parameters[0]!
}

function lowerConditionalExpression(expression: ts.ConditionalExpression, context: FunctionContext): ValueID {
  requireBooleanCondition(expression.condition, context.checker)
  const resultType = context.checker.getTypeAtLocation(expression)
  if (valueKind(resultType, context.checker) == null) {
    throw unsupported(expression, {kind: 'valueType', typeText: context.checker.typeToString(resultType)})
  }
  const condition = lowerExpression(expression.condition, context)
  return lowerValueBranch(
    expression,
    condition,
    () => lowerExpression(expression.whenTrue, context),
    () => lowerExpression(expression.whenFalse, context),
    context,
  )
}

// `a && b` evaluates b only when a is true and yields false otherwise; `a || b` mirrors it —
// the shared value-branch shape with one arm being a boolean constant.
function lowerLogicalExpression(expression: ts.BinaryExpression, context: FunctionContext): ValueID {
  requireBooleanCondition(expression.left, context.checker)
  requireBooleanCondition(expression.right, context.checker)
  const isAnd = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  const condition = lowerExpression(expression.left, context)
  return lowerValueBranch(
    expression,
    condition,
    () => isAnd
      ? lowerExpression(expression.right, context)
      : addInstruction(context, expression, {kind: 'booleanConstant', value: true}),
    () => isAnd
      ? addInstruction(context, expression, {kind: 'booleanConstant', value: false})
      : lowerExpression(expression.right, context),
    context,
  )
}

function arithmeticOperator(kind: ts.SyntaxKind): Extract<InstructionIR, {kind: 'binary'}>['operator'] | null {
  switch (kind) {
    case ts.SyntaxKind.PlusToken: return 'add'
    case ts.SyntaxKind.MinusToken: return 'subtract'
    case ts.SyntaxKind.AsteriskToken: return 'multiply'
    case ts.SyntaxKind.SlashToken: return 'divide'
    default: return null
  }
}

function comparisonOperator(kind: ts.SyntaxKind): ComparisonOperator | null {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken: return 'lessThan'
    case ts.SyntaxKind.LessThanEqualsToken: return 'lessThanOrEqual'
    case ts.SyntaxKind.GreaterThanToken: return 'greaterThan'
    case ts.SyntaxKind.GreaterThanEqualsToken: return 'greaterThanOrEqual'
    case ts.SyntaxKind.EqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken: return 'equal'
    default: return null
  }
}

function requireNumberType(node: ts.Node, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(node)
  if ((type.flags & ts.TypeFlags.NumberLike) === 0) {
    throw unsupported(node, {kind: 'nonNumberOperand', typeText: checker.typeToString(type)})
  }
}

// The single value kind a type describes, or null when the type mixes kinds (a union like
// number | boolean), mixes object shapes (a union like {x} | {x, y} — a latent tagged
// union that needs discriminant support, or an inconsistency worth naming), or falls
// outside the accepted kinds entirely (e.g. string).
export function valueKind(type: ts.Type, checker: ts.TypeChecker): 'number' | 'boolean' | 'object' | null {
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 'number'
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean'
  if ((type.flags & ts.TypeFlags.Object) !== 0) return 'object'
  if (type.isUnion()) {
    let shared: 'number' | 'boolean' | 'object' | null = null
    let objectShape: string | null = null
    for (const member of type.types) {
      const kind = valueKind(member, checker)
      if (kind == null || (shared != null && kind !== shared)) return null
      if (kind === 'object') {
        // TypeScript normalizes a union of disjoint shapes by adding each member's missing
        // properties as optional-undefined, so only the required properties describe the
        // member's real shape.
        const shape = checker.getPropertiesOfType(member)
          .filter(property => (property.flags & ts.SymbolFlags.Optional) === 0)
          .map(property => property.name)
          .sort()
          .join(',')
        if (objectShape != null && shape !== objectShape) return null
        objectShape = shape
      }
      shared = kind
    }
    return shared
  }
  return null
}

// Truthiness conditions like `if (width)` on a number are legal TypeScript but outside the
// accepted subset; the engine represents conditions as booleans only.
export function requireBooleanCondition(node: ts.Node, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(node)
  if (valueKind(type, checker) === 'boolean') return
  throw unsupported(node, {kind: 'nonBooleanCondition', typeText: checker.typeToString(type)})
}

// An optional property reads or writes as `number | undefined` — nullability the subset
// does not model. Across branch-merged objects declared with one optional-property type,
// the property may genuinely be missing from some of the objects a reference addresses, so
// letting the access through would observe objects the abstract heap cannot describe.
function requireAccessedPropertyKind(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(access)
  if (valueKind(type, checker) != null) return
  throw unsupported(access, {kind: 'valueType', typeText: checker.typeToString(type)})
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | null {
  if (symbol == null) return null
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
}

function isStandardMathObject(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'Math') return false
  const symbol = checker.getSymbolAtLocation(expression)
  const declarations = symbol?.declarations
  if (declarations == null || declarations.length === 0) return false
  return declarations.every(declaration => declaration.getSourceFile().isDeclarationFile)
}

// Resolves an identifier read: a function-local binding first, then a module binding
// (which reads the binding's slot), else the identifier is unknown.
function identifierValue(symbol: ts.Symbol, node: ts.Identifier, context: FunctionContext): ValueID {
  const local = context.bindings.get(symbol)
  if (local != null) return local
  const binding = context.moduleBindingsBySymbol.get(symbol)
  if (binding != null) return addInstruction(context, node, {kind: 'moduleRead', binding})
  throw unsupported(node, {kind: 'unknownIdentifier', name: node.text})
}

// Assigns an identifier: rebinding for a local, a slot write for a module binding.
function assignIdentifier(
  symbol: ts.Symbol,
  node: ts.Identifier,
  value: ValueID,
  wholeExpression: ts.Expression,
  context: FunctionContext,
): ValueID {
  if (context.bindings.has(symbol)) {
    context.bindings.set(symbol, value)
    return value
  }
  const binding = context.moduleBindingsBySymbol.get(symbol)
  if (binding != null) return addInstruction(context, wholeExpression, {kind: 'moduleWrite', binding, value})
  throw unsupported(node, {kind: 'unknownIdentifier', name: node.text})
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  throw unsupported(name, {kind: 'computedPropertyName'})
}

function unwrap(expression: ts.Expression, checker: ts.TypeChecker): ts.Expression {
  let current = expression
  while (true) {
    if (ts.isParenthesizedExpression(current) || ts.isSatisfiesExpression(current)) {
      // Neither changes the expression's type.
      current = current.expression
      continue
    }
    // Only `as const` assertions reach here — the acceptance check rejected every other
    // as/angle-bracket form before lowering started — and a const assertion narrows a
    // literal to its own literal type, so peeling it changes nothing.
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      current = current.expression
      continue
    }
    // The non-null assertion `x!` peels only while the value kind is unchanged underneath —
    // on a nullable type, e.g. `x!` with `x: number | null`, the static type stops
    // describing the value the analysis models, so stop.
    if (ts.isNonNullExpression(current)) {
      const assertedType = checker.getTypeAtLocation(current)
      const operandType = checker.getTypeAtLocation(current.expression)
      if (valueKind(assertedType, checker) !== valueKind(operandType, checker)) {
        throw unsupported(current, {
          kind: 'kindChangingAssertion',
          fromText: checker.typeToString(operandType),
          toText: checker.typeToString(assertedType),
        })
      }
      current = current.expression
      continue
    }
    return current
  }
}
