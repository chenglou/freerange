import * as ts from 'typescript'
import type {ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {
  addInstruction,
  changedBindings,
  createBlock,
  requiredBinding,
  requiredBranchBinding,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
} from './context.ts'

export function lowerExpression(expression: ts.Expression, context: FunctionContext): ValueID {
  const current = unwrap(expression)
  if (ts.isNumericLiteral(current)) {
    return addInstruction(context, {kind: 'constant', value: Number(current.text)})
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.MinusToken) {
    const zero = addInstruction(context, {kind: 'constant', value: 0})
    const value = lowerExpression(current.operand, context)
    return addInstruction(context, {kind: 'binary', operator: 'subtract', left: zero, right: value})
  }
  if (ts.isConditionalExpression(current)) {
    return lowerConditionalExpression(current, context)
  }
  if (ts.isIdentifier(current)) {
    return requiredBinding(requiredSymbol(current, context.checker), current, context)
  }
  if (ts.isObjectLiteralExpression(current)) {
    const properties = current.properties.map(property => {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property)
        if (symbol == null) throw unsupported(property, 'Shorthand property without a value symbol')
        return {name: property.name.text, value: requiredBinding(symbol, property.name, context)}
      }
      if (ts.isPropertyAssignment(property)) {
        return {name: propertyName(property.name), value: lowerExpression(property.initializer, context)}
      }
      throw unsupported(property, 'Object property')
    })
    return addInstruction(context, {kind: 'object', properties})
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isPropertyAccessExpression(current.left)
  ) {
    const object = lowerExpression(current.left.expression, context)
    const value = lowerExpression(current.right, context)
    return addInstruction(context, {kind: 'store', object, property: current.left.name.text, value})
  }
  if (
    ts.isBinaryExpression(current)
    && current.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(current.left)
  ) {
    const symbol = requiredSymbol(current.left, context.checker)
    requiredBinding(symbol, current.left, context)
    const value = lowerExpression(current.right, context)
    context.bindings.set(symbol, value)
    return value
  }
  if (ts.isBinaryExpression(current) && ts.isIdentifier(current.left)) {
    const operator = compoundAssignmentOperator(current.operatorToken.kind)
    if (operator != null) {
      const symbol = requiredSymbol(current.left, context.checker)
      const left = requiredBinding(symbol, current.left, context)
      const right = lowerExpression(current.right, context)
      const value = addInstruction(context, {kind: 'binary', operator, left, right})
      context.bindings.set(symbol, value)
      return value
    }
  }
  if (
    (ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current))
    && (current.operator === ts.SyntaxKind.PlusPlusToken || current.operator === ts.SyntaxKind.MinusMinusToken)
    && ts.isIdentifier(current.operand)
  ) {
    const symbol = requiredSymbol(current.operand, context.checker)
    const previous = requiredBinding(symbol, current.operand, context)
    const one = addInstruction(context, {kind: 'constant', value: 1})
    const value = addInstruction(context, {
      kind: 'binary',
      operator: current.operator === ts.SyntaxKind.PlusPlusToken ? 'add' : 'subtract',
      left: previous,
      right: one,
    })
    context.bindings.set(symbol, value)
    return ts.isPrefixUnaryExpression(current) ? value : previous
  }
  if (ts.isBinaryExpression(current)) {
    const arithmetic = arithmeticOperator(current.operatorToken.kind)
    const comparison = comparisonOperator(current.operatorToken.kind)
    if (arithmetic == null && comparison == null) {
      throw unsupported(current, `Binary operator ${current.operatorToken.getText(context.sourceFile)}`)
    }
    requireNumberType(current.left, context.checker, 'Left operand')
    requireNumberType(current.right, context.checker, 'Right operand')
    const left = lowerExpression(current.left, context)
    const right = lowerExpression(current.right, context)
    return arithmetic != null
      ? addInstruction(context, {kind: 'binary', operator: arithmetic, left, right})
      : addInstruction(context, {kind: 'compare', operator: comparison!, left, right})
  }
  if (ts.isCallExpression(current)) {
    if (ts.isIdentifier(current.expression)) {
      const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(current.expression), context.checker)
      const functionID = symbol == null ? undefined : context.functionsBySymbol.get(symbol)
      if (functionID == null) throw unsupported(current, `Function call ${current.expression.text}`)
      const arguments_ = current.arguments.map(argument => lowerExpression(argument, context))
      return addInstruction(context, {kind: 'call', function: functionID, arguments: arguments_})
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const method = current.expression.name.text
      const standardMath = isStandardMathObject(current.expression.expression, context.checker)
      if (standardMath && method === 'floor' && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker, 'Math.floor argument')
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, {kind: 'floor', value})
      }
      if (standardMath && (method === 'min' || method === 'max') && current.arguments.length > 0) {
        for (const argument of current.arguments) requireNumberType(argument, context.checker, `Math.${method} argument`)
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, {kind: method === 'min' ? 'minimum' : 'maximum', values})
      }
      throw unsupported(current, `Function call ${current.expression.getText(context.sourceFile)}`)
    }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const objectType = context.checker.getTypeAtLocation(current.expression)
    if ((objectType.flags & ts.TypeFlags.Object) === 0) {
      throw unsupported(current.expression, `Property read from ${context.checker.typeToString(objectType)}`)
    }
    const object = lowerExpression(current.expression, context)
    return addInstruction(context, {kind: 'property', object, property: current.name.text})
  }
  throw unsupported(current, 'Expression')
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
  const condition = lowerExpression(expression.condition, context)
  const bindingsBeforeBranch = new Map(context.bindings)
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
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
  })
  terminate(falseBlock, {
    kind: 'jump',
    target: {
      block: continuation,
      arguments: [falseValue, ...changed.map(symbol => requiredBranchBinding(symbol, falseBindings))],
    },
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

function requireNumberType(node: ts.Node, checker: ts.TypeChecker, description: string): void {
  const type = checker.getTypeAtLocation(node)
  if ((type.flags & ts.TypeFlags.NumberLike) === 0) throw unsupported(node, `${description} with type ${checker.typeToString(type)}`)
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

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  throw unsupported(name, 'Computed object property name')
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}
