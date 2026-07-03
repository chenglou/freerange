import * as ts from 'typescript'
import type {ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {
  addInstruction,
  addSite,
  changedBindings,
  createBlock,
  requiredBranchBinding,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
} from './context.ts'

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
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(current.left)
  ) {
    requireAccessedPropertyKind(current.left, context.checker)
    const object = lowerExpression(current.left.expression, context)
    const value = lowerExpression(current.right, context)
    return addInstruction(context, current, {kind: 'store', object, property: current.left.name.text, value})
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(current.left)
  ) {
    const symbol = requiredSymbol(current.left, context.checker)
    const moduleBinding = context.moduleBindingsBySymbol.get(symbol)
    if (!context.bindings.has(symbol) && moduleBinding == null) {
      throw unsupported(current.left, {kind: 'unknownIdentifier', name: current.left.text})
    }
    // Rebinding is only sound when the target's declared type holds a single value kind —
    // otherwise branches could bind different kinds that meet at a block join. Function
    // locals with mixed-kind declared types already stop at their declaration; a module
    // binding can still hold one (a top-level `let config: unknown` initializes through
    // the initializer's own declarator path), so for those the write itself stops here.
    // The checker returns the declared type at an assignment target, not a narrowed one:
    // narrowing does not apply to write positions.
    const targetType = context.checker.getTypeAtLocation(current.left)
    if (valueKind(targetType, context.checker) == null) {
      throw unsupported(current.left, {kind: 'valueType', typeText: context.checker.typeToString(targetType)})
    }
    const value = lowerExpression(current.right, context)
    if (moduleBinding != null) {
      return addInstruction(context, current, {kind: 'moduleWrite', binding: moduleBinding, value})
    }
    context.bindings.set(symbol, value)
    return value
  }
  if (ts.isBinaryExpression(current) && ts.isIdentifier(current.left)) {
    const operator = compoundAssignmentOperator(current.operatorToken.kind)
    if (operator != null) {
      const symbol = requiredSymbol(current.left, context.checker)
      const left = identifierValue(symbol, current.left, context)
      const right = lowerExpression(current.right, context)
      const value = addInstruction(context, current, {kind: 'binary', operator, left, right})
      return assignIdentifier(symbol, current.left, value, current, context)
    }
  }
  if (
    (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
    && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(current.operand)
  ) {
    const symbol = requiredSymbol(current.operand, context.checker)
    const previous = identifierValue(symbol, current.operand, context)
    const one = addInstruction(context, current, {kind: 'constant', value: 1})
    const value = addInstruction(context, current, {
      kind: 'binary',
      operator: current.operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract',
      left: previous,
      right: one,
    })
    assignIdentifier(symbol, current.operand, value, current, context)
    return ts.isPrefixUnaryExpression(current) ? value : previous
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

export function compoundAssignmentOperator(kind: ts.SyntaxKind): Extract<InstructionIR, {kind: 'binary'}>['operator'] | null {
  switch (kind) {
    case ts.SyntaxKind.PlusEqualsToken: return 'add'
    case ts.SyntaxKind.MinusEqualsToken: return 'subtract'
    case ts.SyntaxKind.AsteriskEqualsToken: return 'multiply'
    case ts.SyntaxKind.SlashEqualsToken: return 'divide'
    default: return null
  }
}

function lowerConditionalExpression(expression: ts.ConditionalExpression, context: FunctionContext): ValueID {
  requireBooleanCondition(expression.condition, context.checker)
  const resultType = context.checker.getTypeAtLocation(expression)
  if (valueKind(resultType, context.checker) == null) {
    throw unsupported(expression, {kind: 'valueType', typeText: context.checker.typeToString(resultType)})
  }
  const condition = lowerExpression(expression.condition, context)
  const bindingsBeforeBranch = new Map(context.bindings)
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
    site: addSite(context, expression),
  })
  context.currentBlock = context.blocks[whenTrue]!
  context.bindings = new Map(bindingsBeforeBranch)
  const trueValue = lowerExpression(expression.whenTrue, context)
  const trueBlock = context.currentBlock
  const trueBindings = context.bindings
  context.currentBlock = context.blocks[whenFalse]!
  context.bindings = new Map(bindingsBeforeBranch)
  const falseValue = lowerExpression(expression.whenFalse, context)
  const falseBlock = context.currentBlock
  const falseBindings = context.bindings
  const changed = changedBindings(bindingsBeforeBranch, trueBindings, falseBindings)
  const continuation = createBlock(context, changed.length + 1)
  terminate(trueBlock, {
    kind: 'jump',
    target: {
      block: continuation,
      arguments: [trueValue, ...changed.map(symbol => requiredBranchBinding(symbol, trueBindings))],
    },
    site: addSite(context, expression),
  })
  terminate(falseBlock, {
    kind: 'jump',
    target: {
      block: continuation,
      arguments: [falseValue, ...changed.map(symbol => requiredBranchBinding(symbol, falseBindings))],
    },
    site: addSite(context, expression),
  })
  context.currentBlock = context.blocks[continuation]!
  context.bindings = new Map(bindingsBeforeBranch)
  for (let index = 0; index < changed.length; index++) {
    context.bindings.set(changed[index]!, context.currentBlock.parameters[index + 1]!)
  }
  return context.currentBlock.parameters[0]!
}

// `a && b` evaluates b only when a is true and yields false otherwise; `a || b` mirrors it.
// Same CFG shape as a ternary with one arm being a boolean constant.
function lowerLogicalExpression(expression: ts.BinaryExpression, context: FunctionContext): ValueID {
  requireBooleanCondition(expression.left, context.checker)
  requireBooleanCondition(expression.right, context.checker)
  const isAnd = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  const condition = lowerExpression(expression.left, context)
  const bindingsBeforeBranch = new Map(context.bindings)
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
    site: addSite(context, expression),
  })
  context.currentBlock = context.blocks[whenTrue]!
  context.bindings = new Map(bindingsBeforeBranch)
  const trueValue = isAnd
    ? lowerExpression(expression.right, context)
    : addInstruction(context, expression, {kind: 'booleanConstant', value: true})
  const trueBlock = context.currentBlock
  const trueBindings = context.bindings
  context.currentBlock = context.blocks[whenFalse]!
  context.bindings = new Map(bindingsBeforeBranch)
  const falseValue = isAnd
    ? addInstruction(context, expression, {kind: 'booleanConstant', value: false})
    : lowerExpression(expression.right, context)
  const falseBlock = context.currentBlock
  const falseBindings = context.bindings
  const changed = changedBindings(bindingsBeforeBranch, trueBindings, falseBindings)
  const continuation = createBlock(context, changed.length + 1)
  terminate(trueBlock, {
    kind: 'jump',
    target: {
      block: continuation,
      arguments: [trueValue, ...changed.map(symbol => requiredBranchBinding(symbol, trueBindings))],
    },
    site: addSite(context, expression),
  })
  terminate(falseBlock, {
    kind: 'jump',
    target: {
      block: continuation,
      arguments: [falseValue, ...changed.map(symbol => requiredBranchBinding(symbol, falseBindings))],
    },
    site: addSite(context, expression),
  })
  context.currentBlock = context.blocks[continuation]!
  context.bindings = new Map(bindingsBeforeBranch)
  for (let index = 0; index < changed.length; index++) {
    context.bindings.set(changed[index]!, context.currentBlock.parameters[index + 1]!)
  }
  return context.currentBlock.parameters[0]!
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
