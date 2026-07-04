import * as ts from 'typescript'
import type {ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import {declaredOnlyInDeclarationFiles, platformFact} from './platform.ts'
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
    // A negated literal folds into one constant instead of lowering as `0 - operand`.
    // For finite literals both are exact; for `-Infinity` the fold is the difference
    // between an exact constant and a collapse to unknown, because interval arithmetic
    // deliberately gives up on non-finite operands (Infinity - Infinity is NaN).
    const negated = unwrap(current.operand, context.checker)
    if (ts.isNumericLiteral(negated)) {
      return addInstruction(context, current, {kind: 'constant', value: -Number(negated.text)})
    }
    if (isGlobalInfinity(negated, context.checker)) {
      return addInstruction(context, current, {kind: 'constant', value: Number.NEGATIVE_INFINITY})
    }
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
  if (ts.isArrayLiteralExpression(current)) {
    const literalKind = valueKind(context.checker.getTypeAtLocation(current), context.checker)
    const elements: ValueID[] = []
    for (const element of current.elements) {
      if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
        throw unsupported(element, {kind: 'expressionForm', syntax: ts.SyntaxKind[element.kind]})
      }
      elements.push(lowerExpression(element, context))
    }
    // The literal's static type decides the form: `[4, 8, 24] as const` is a tuple and
    // stays exact per position; a plain literal is an array and joins its elements.
    return addInstruction(context, current, {kind: 'arrayLiteral', elements, form: literalKind === 'tuple' ? 'tuple' : 'array'})
  }
  if (ts.isNonNullExpression(current) && ts.isElementAccessExpression(current.expression)) {
    // `arr[i]!` — asserts presence; an unproven read becomes an in-bounds assumption line.
    return lowerElementAccess(current.expression, true, context)
  }
  if (ts.isElementAccessExpression(current)) {
    // Bare arr[i] types T | undefined; the result honestly carries the possible miss.
    return lowerElementAccess(current, false, context)
  }
  if (ts.isObjectLiteralExpression(current)) {
    const properties: Array<{name: string; value: ValueID}> = []
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property)
        if (symbol == null) throw unsupported(property, {kind: 'missingSymbol'})
        properties.push({name: property.name.text, value: identifierValue(symbol, property.name, context)})
        continue
      }
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name)
        // `__proto__: value` in a literal is prototype-setting syntax at runtime — no own
        // property is created — while the checker types it as a plain property.
        if (name === '__proto__') throw unsupported(property, {kind: 'protoProperty'})
        properties.push({name, value: lowerExpression(property.initializer, context)})
        continue
      }
      // `{...spring, pos: newPos}` — the update idiom of the immutable subset. Every object
      // has a statically known fixed shape, so a spread is one read per source property;
      // later entries override earlier ones below.
      if (ts.isSpreadAssignment(property)) {
        // The spread must be the literal's first entry. Width subtyping lets the spread
        // value carry properties its static type never names, and the runtime spread
        // copies those too — so a spread after other entries could silently override them
        // (`{...defaults, ...overrides}` where the overrides value carries a `volume` its
        // type omits). With the spread first, whatever extras it copies are either
        // overridden by the later explicit entries or unreadable through the result type.
        if (properties.length > 0) {
          throw unsupported(property, {kind: 'spreadAfterProperties'})
        }
        const sourceType = context.checker.getTypeAtLocation(property.expression)
        if (valueKind(sourceType, context.checker) !== 'object') {
          throw unsupported(property, {kind: 'valueType', typeText: context.checker.typeToString(sourceType)})
        }
        const source = lowerExpression(property.expression, context)
        for (const member of context.checker.getPropertiesOfType(sourceType)) {
          // An optional property is present or absent per value, and a spread copies it
          // only when present — `{...defaults, ...overrides}` with `overrides.volume`
          // optional either overrides or keeps the default, and the analysis cannot know
          // which. Skipping the property would silently keep the default's value while the
          // runtime took the override, so the spread is rejected instead.
          if ((member.flags & ts.SymbolFlags.Optional) !== 0) {
            throw unsupported(property, {kind: 'spreadOptionalProperty', property: member.name})
          }
          if (member.name === '__proto__') throw unsupported(property, {kind: 'protoProperty'})
          // Each copied property's kind must be representable: a `value: number | boolean`
          // property passes no read gate, so the record join may have dropped it, and the
          // spread's own read would be the one ungated path to the dropped property.
          const memberType = context.checker.getTypeOfSymbol(member)
          if (valueKind(memberType, context.checker) == null) {
            throw unsupported(property, {kind: 'valueType', typeText: context.checker.typeToString(memberType)})
          }
          properties.push({
            name: member.name,
            value: addInstruction(context, property, {kind: 'property', object: source, property: member.name}),
          })
        }
        continue
      }
      throw unsupported(property, {kind: 'objectPropertyForm'})
    }
    // Last write wins, matching runtime spread semantics; earlier reads still evaluate.
    const lastByName = new Map<string, {name: string; value: ValueID}>()
    for (const property of properties) lastByName.set(property.name, property)
    return addInstruction(context, current, {kind: 'object', properties: [...lastByName.values()]})
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
  if (current.kind === ts.SyntaxKind.NullKeyword) {
    return addInstruction(context, current, {kind: 'nullishConstant', sentinel: 'null'})
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
    // `a ?? b` is `a` when not missing, else `b`. The whole expression's type must be a
    // representable kind — `(record | null) ?? 0` mixes record and number arms.
    const resultType = context.checker.getTypeAtLocation(current)
    if (valueKind(resultType, context.checker) == null) {
      throw unsupported(current, {kind: 'valueType', typeText: context.checker.typeToString(resultType)})
    }
    const left = lowerExpression(current.left, context)
    const notMissing = addInstruction(context, current, {kind: 'nullishCheck', value: left, sentinel: 'nullish', negated: true})
    // The true arm re-reads a's slot, which the branch refinement has unwrapped.
    return lowerValueBranch(
      current,
      notMissing,
      () => left,
      () => lowerExpression(current.right, context),
      context,
    )
  }
  if (ts.isBinaryExpression(current)) {
    const missingCheck = missingSentinelCheck(current, context)
    if (missingCheck != null) return missingCheck
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
    const receiverKind = valueKind(objectType, context.checker)
    if ((receiverKind === 'array' || receiverKind === 'tuple') && current.name.text === 'length') {
      const array = lowerExpression(current.expression, context)
      return addInstruction(context, current, {kind: 'arrayLength', array})
    }
    // An enum member read gets its own name and rewrite; the generic receiver prose
    // ("property read from typeof Direction") names the checker's type, not the construct.
    const receiverSymbol = ts.isIdentifier(current.expression)
      ? context.checker.getSymbolAtLocation(current.expression)
      : undefined
    if (receiverSymbol != null && (receiverSymbol.flags & (ts.SymbolFlags.RegularEnum | ts.SymbolFlags.ConstEnum)) !== 0) {
      throw unsupported(current, {kind: 'enumMemberRead'})
    }
    // Through valueKind: single record types and unions of one recursive shape both read
    // fine (an admitted union joins losslessly, so every member's property is present),
    // while index signatures, callables, and mixed shapes reject.
    if (valueKind(objectType, context.checker) !== 'object') {
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
// Lowers a statement-position condition into branch terminators with short-circuit CFG:
// `if (a && b)` becomes two chained branches sharing the false target, so each simple
// condition is its own branch producer and narrows on its own — nested guards and inline
// && guards refine identically, by construction. Conditions are assignment-free (see
// lowerStatementExpression), so the intermediate blocks carry no parameters and bindings
// never change inside.
export function lowerBranchingCondition(
  expression: ts.Expression,
  whenTrue: number,
  whenFalse: number,
  context: FunctionContext,
): void {
  const current = unwrap(expression, context.checker)
  if (ts.isBinaryExpression(current)
    && (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || current.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    const isAnd = current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    const middle = createBlock(context)
    if (isAnd) {
      lowerBranchingCondition(current.left, middle, whenFalse, context)
    } else {
      lowerBranchingCondition(current.left, whenTrue, middle, context)
    }
    context.currentBlock = context.blocks[middle]!
    lowerBranchingCondition(current.right, whenTrue, whenFalse, context)
    return
  }
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.ExclamationToken) {
    lowerBranchingCondition(current.operand, whenFalse, whenTrue, context)
    return
  }
  requireBooleanCondition(current, context.checker)
  const condition = lowerExpression(current, context)
  terminate(context.currentBlock, {
    kind: 'branch',
    condition,
    whenTrue: {block: whenTrue, arguments: []},
    whenFalse: {block: whenFalse, arguments: []},
    site: addSite(context, current),
  })
}

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
  // Through valueKind, not a raw flag test, so there is one definition of "number":
  // a literal union like `1 | 2` — the numeric discriminant of a tagged record — is a
  // number here exactly as it is at the declarator and destructuring gates.
  if (valueKind(type, checker) !== 'number') {
    throw unsupported(node, {kind: 'nonNumberOperand', typeText: checker.typeToString(type)})
  }
}

// The single value kind a type describes, or null when the type mixes kinds (a union like
// number | boolean), mixes object shapes (a union like {x} | {x, y} — a latent tagged
// union that needs discriminant support, or an inconsistency worth naming), or falls
// outside the accepted kinds entirely (e.g. string).
export function valueKind(type: ts.Type, checker: ts.TypeChecker): 'number' | 'boolean' | 'object' | 'nullable' | 'array' | 'tuple' | null {
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 'number'
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean'
  // The type system's own split, mirrored: tuple types are positional and exact, array
  // types are homogeneous. Checked before the general object arm (both carry the Object
  // flag and index signatures).
  if (checker.isTupleType(type)) return 'tuple'
  if (checker.isArrayType(type)) return 'array'
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    // An index signature, e.g. Record<string, number>, admits properties the type never
    // names: a value typed with one can carry any key set at runtime, so the abstract
    // record — built from a specific literal — cannot honor reads or spreads the signature
    // licenses. `stats.misses` type-checks against Record<string, number> while the value
    // is `{clicks: 1}`, and `{...defaults, ...overrides}` would copy nothing from an
    // override map whose type names no properties. A callable or constructable type is
    // not a record either: `point.toString` type-checks on every object literal, but the
    // record value built from the literal carries no such property, and a class's static
    // side is a constructor, not plain data. Finally, the type must have at least one
    // required non-callable property, or primitives inhabit it — every non-null value
    // satisfies `{}`, and a number satisfies `{toString(): string}` — letting a number
    // and a record meet at a join.
    if (checker.getIndexInfosOfType(type).length > 0) return null
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return null
    const anchored = checker.getPropertiesOfType(type).some(property =>
      (property.flags & ts.SymbolFlags.Optional) === 0
      && checker.getTypeOfSymbol(property).getCallSignatures().length === 0)
    return anchored ? 'object' : null
  }
  if (type.isUnion()) {
    // `T | null`, `T | undefined`, and `T | null | undefined` classify as nullable when T
    // itself classifies to one kind. Gates that cannot carry a missing value keep
    // rejecting ('nullable' matches neither 'number' nor 'object'); kind-agnostic gates
    // (declarators, ternary results, destructure elements, returns) accept.
    const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    if (type.types.some(member => (member.flags & missingFlags) !== 0)) {
      const rest = type.types.filter(member => (member.flags & missingFlags) === 0)
      if (rest.length !== 1) return null
      const restKind = valueKind(rest[0]!, checker)
      return restKind == null || restKind === 'nullable' ? null : 'nullable'
    }
    let shared: 'number' | 'boolean' | 'object' | 'nullable' | null = null
    let objectShape: string | null = null
    for (const member of type.types) {
      const kind = valueKind(member, checker)
      if (kind == null || kind === 'nullable' || kind === 'array' || kind === 'tuple' || (shared != null && kind !== shared)) return null
      if (kind === 'object') {
        // TypeScript normalizes a union of disjoint shapes by adding each member's missing
        // properties as optional-undefined, so only the required properties describe the
        // member's real shape. The property KINDS are part of the shape, recursively: a
        // discriminated union like {ok: true; value: number} | {ok: false; value: boolean}
        // has one name set but two meanings for `value`, and payloads can diverge at any
        // nesting depth — admitting either would let a narrowed read reach a property the
        // record join had to drop. Members admitted here therefore join losslessly:
        // matching fingerprints mean matching names and kinds at every depth.
        const shape = shapeFingerprint(member, checker, [])
        if (shape == null || (objectShape != null && shape !== objectShape)) return null
        objectShape = shape
      }
      shared = kind
    }
    return shared
  }
  return null
}

// The recursive shape of an object type: property names with their kinds, nested records
// spelled out in full. Two union members agree only when their fingerprints are equal.
// 'other' labels a kind the analysis cannot represent; 'other' matches 'other', which is
// safe not because such values cannot exist — a property typed
// {width: number} | {code: number} is 'other' and its values are ordinary literals — but
// because every read of an 'other' property is rejected: direct access and destructuring
// gate the result type through valueKind, and spreads gate each copied property the same
// way. A fingerprint the seen set or depth cap CUT SHORT is different: below the cutoff
// there can be readable properties the comparison never saw (discriminant narrowing types
// deep reads against a single member), so a truncated fingerprint is null and never
// compares equal — the union is rejected, mirroring how the module shape walk goes opaque
// at its cap.
function shapeFingerprint(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): string | null {
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 'number'
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean'
  if ((type.flags & ts.TypeFlags.Object) !== 0) {
    if (seen.length >= 8 || seen.includes(type)) return null
    if (checker.getIndexInfosOfType(type).length > 0) return 'other'
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return 'other'
    const properties: string[] = []
    for (const property of checker.getPropertiesOfType(type)) {
      if ((property.flags & ts.SymbolFlags.Optional) !== 0) continue
      const propertyFingerprint = shapeFingerprint(checker.getTypeOfSymbol(property), checker, [...seen, type])
      if (propertyFingerprint == null) return null
      properties.push(`${property.name}:${propertyFingerprint}`)
    }
    return `record{${properties.sort().join(',')}}`
  }
  if (type.isUnion()) {
    if (type.types.every(member => (member.flags & ts.TypeFlags.NumberLike) !== 0)) return 'number'
    if (type.types.every(member => (member.flags & ts.TypeFlags.BooleanLike) !== 0)) return 'boolean'
    const memberFingerprints = type.types.map(member => shapeFingerprint(member, checker, seen))
    if (memberFingerprints.some(fingerprint => fingerprint == null)) return null
    if (new Set(memberFingerprints).size === 1) return memberFingerprints[0]!
  }
  return 'other'
}

// Truthiness conditions like `if (width)` on a number are legal TypeScript but outside the
// accepted subset; the engine represents conditions as booleans only.
export function requireBooleanCondition(node: ts.Node, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(node)
  if (valueKind(type, checker) === 'boolean') return
  throw unsupported(node, {kind: 'nonBooleanCondition', typeText: checker.typeToString(type)})
}

// An optional property reads as `number | undefined` — nullability the subset does not
// model. Across branch-merged records declared with one optional-property type, the
// property may genuinely be missing on some paths, so letting the access through would
// read a property the record value may not carry.
function requireAccessedPropertyKind(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): void {
  // An optional property stays out even though its `T | undefined` type now classifies:
  // the record value genuinely may not carry the property (a join dropped it, or the
  // literal omitted it), so there is nothing to read. Required properties of missing-able
  // kinds read fine.
  const receiverType = checker.getTypeAtLocation(access.expression)
  const property = checker.getPropertyOfType(receiverType, access.name.text)
  const type = checker.getTypeAtLocation(access)
  if (property != null && (property.flags & ts.SymbolFlags.Optional) !== 0) {
    throw unsupported(access, {kind: 'valueType', typeText: checker.typeToString(type)})
  }
  if (valueKind(type, checker) != null) return
  throw unsupported(access, {kind: 'valueType', typeText: checker.typeToString(type)})
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | null {
  if (symbol == null) return null
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
}

function isStandardMathObject(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'Math') return false
  return declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(expression))
}

function lowerElementAccess(access: ts.ElementAccessExpression, asserted: boolean, context: FunctionContext): ValueID {
  const receiverType = context.checker.getTypeAtLocation(access.expression)
  const receiverKind = valueKind(receiverType, context.checker)
  if (receiverKind !== 'array' && receiverKind !== 'tuple') {
    throw unsupported(access.expression, {kind: 'propertyReadOnNonObject', typeText: context.checker.typeToString(receiverType)})
  }
  const resultType = context.checker.getTypeAtLocation(access)
  if (valueKind(resultType, context.checker) == null) {
    throw unsupported(access, {kind: 'valueType', typeText: context.checker.typeToString(resultType)})
  }
  requireNumberType(access.argumentExpression, context.checker)
  const array = lowerExpression(access.expression, context)
  const index = lowerExpression(access.argumentExpression, context)
  return addInstruction(context, access, {kind: 'arrayIndex', array, index, asserted, provenBounds: false})
}

// Recognizes `x === null`, `x !== undefined`, `x == null`, and friends. The loose forms
// test both sentinels at once; the strict forms test one, and the refinement consults the
// VALUE's own possible sentinels, so `x !== null` on a possibly-undefined value narrows
// null away while undefined honestly survives.
function missingSentinelCheck(expression: ts.BinaryExpression, context: FunctionContext): ValueID | null {
  const operator = expression.operatorToken.kind
  const strict = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
  const loose = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  if (!strict && !loose) return null
  const negated = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  const sentinelOf = (side: ts.Expression): 'null' | 'undefined' | null => {
    const unwrapped = unwrap(side, context.checker)
    if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return 'null'
    if (ts.isIdentifier(unwrapped) && unwrapped.text === 'undefined'
      && declaredOnlyInDeclarationFiles(context.checker.getSymbolAtLocation(unwrapped))) return 'undefined'
    return null
  }
  const leftSentinel = sentinelOf(expression.left)
  const rightSentinel = sentinelOf(expression.right)
  const sentinel = leftSentinel ?? rightSentinel
  if (sentinel == null || (leftSentinel != null && rightSentinel != null)) return null
  const checked = leftSentinel == null ? expression.left : expression.right
  const value = lowerExpression(checked, context)
  return addInstruction(context, expression, {
    kind: 'nullishCheck',
    value,
    sentinel: loose ? 'nullish' : sentinel,
    negated,
  })
}

function isGlobalInfinity(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'Infinity') return false
  return declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(expression))
}

// Resolves an identifier read: a function-local binding first, then a module binding
// (which reads the binding's slot), then the global `Infinity` as an exact constant,
// else the identifier is unknown. A local or module binding named Infinity has a
// different symbol and wins above; the global check is the same declaration-file
// defense the Math and platform dispatches use.
function identifierValue(symbol: ts.Symbol, node: ts.Identifier, context: FunctionContext): ValueID {
  const local = context.bindings.get(symbol)
  if (local != null) return local
  const binding = context.moduleBindingsBySymbol.get(symbol)
  if (binding != null) return addInstruction(context, node, {kind: 'moduleRead', binding})
  if (isGlobalInfinity(node, context.checker)) {
    return addInstruction(context, node, {kind: 'constant', value: Number.POSITIVE_INFINITY})
  }
  if (node.text === 'undefined' && declaredOnlyInDeclarationFiles(context.checker.getSymbolAtLocation(node))) {
    return addInstruction(context, node, {kind: 'nullishConstant', sentinel: 'undefined'})
  }
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
    // describing the value the analysis models, so stop. The one blessed kind-changing
    // form is `arr[i]!`: element reads type T | undefined under noUncheckedIndexedAccess,
    // and the element-access lowering gives the asserted read its explicit treatment — an
    // in-bounds assumption line, or a bounds proof when the loop supplies one.
    if (ts.isNonNullExpression(current)) {
      const assertedType = checker.getTypeAtLocation(current)
      const operandType = checker.getTypeAtLocation(current.expression)
      // The one blessed kind-changing assertion is `arr[i]!`: element reads type
      // T | undefined under noUncheckedIndexedAccess, and the asserted read gets its
      // explicit treatment in lowering — an in-bounds assumption line, or a bounds proof
      // when a loop supplies one. It stays wrapped so lowering can see the assertion.
      if (ts.isElementAccessExpression(current.expression) && valueKind(assertedType, checker) != null) {
        return current
      }
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
