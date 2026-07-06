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
        const targetKind = valueKind(targetType, context.checker)
        if (targetKind == null) {
          throw unsupported(assignment.target, {kind: 'valueType', typeText: context.checker.typeToString(targetType)})
        }
        const value = lowerExpression(assignment.node.right, context)
        // A binding declared opaque (unknown, a function type) admits writes of any kind;
        // the stored value erases to opaque so a number written on one branch and a
        // boolean on another meet as opaque ⊔ opaque instead of crashing the join. The
        // right side still lowered above, so its constructs stay vetted.
        const stored = targetKind === 'opaque'
          ? addInstruction(context, current, {kind: 'opaqueConstant'})
          : value
        assignIdentifier(symbol, assignment.target, stored, current, context)
        return
      }
      case 'logical': {
        // `x ??= v` / `x ||= v` / `x &&= v` in statement position: the target rebinds to
        // the same value branch the expression spellings lower to — ?? through the
        // missing-value machinery for any carried kind, || and && over booleans.
        const currentValue = identifierValue(symbol, assignment.target, context)
        const targetType = context.checker.getTypeAtLocation(assignment.target)
        let condition: ValueID
        if (assignment.logical === 'nullish') {
          condition = addInstruction(context, current, {kind: 'nullishCheck', value: currentValue, sentinel: 'nullish', negated: true})
        } else {
          if (valueKind(targetType, context.checker) !== 'boolean') {
            throw unsupported(assignment.target, {kind: 'nonBooleanCondition', typeText: context.checker.typeToString(targetType)})
          }
          condition = currentValue
        }
        // For ??= and ||= the kept arm is the current value; for &&= the kept arm is the
        // false side. lowerValueBranch orders (whenTrue, whenFalse).
        const keepOnTrue = assignment.logical !== 'and'
        const rebound = lowerValueBranch(
          current,
          condition,
          keepOnTrue ? () => currentValue : () => lowerExpression(assignment.node.right, context),
          keepOnTrue ? () => lowerExpression(assignment.node.right, context) : () => currentValue,
          context,
        )
        assignIdentifier(symbol, assignment.target, rebound, current, context)
        return
      }
      case 'compound': {
        // `message += suffix` is string concatenation when the checker types the result
        // as a string — the target rebinds to an opaque value, like `width + 'px'` in
        // value position. Any other non-number operand rejects here exactly as the
        // value-position binary arm does, instead of slipping an untyped add through to
        // the engine's kind-mismatch backstop.
        if (assignment.operator === 'add'
          && valueKind(context.checker.getTypeAtLocation(current), context.checker) === 'opaque') {
          lowerExpression(assignment.node.right, context)
          const concatenated = addInstruction(context, current, {kind: 'opaqueConstant'})
          assignIdentifier(symbol, assignment.target, concatenated, current, context)
          return
        }
        requireNumberType(assignment.target, context.checker)
        requireNumberType(assignment.node.right, context.checker)
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
    const literalType = context.checker.getTypeAtLocation(current)
    const literalKind = valueKind(literalType, context.checker)
    // A literal whose own type does not classify — `[1, true]` types as
    // (number | boolean)[], whose element hull no read gate could ever describe — rejects
    // here, covering every position a literal can appear in (declarators have their own
    // gate, but object property values and call arguments do not).
    // The empty literal is exempt: its never[] element type classifies as nothing, but
    // there are no elements to mix.
    if (literalKind !== 'array' && literalKind !== 'tuple' && current.elements.length > 0) {
      throw unsupported(current, {kind: 'valueType', typeText: context.checker.typeToString(literalType)})
    }
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
    // A literal written where a tagged union is expected ({type: 'sidebar', width: 240}
    // returned as Frame) records which variant it builds, so branches building different
    // variants join per tag instead of dropping every mismatched property. The tag VALUE
    // comes from the literal's own checked type, not its syntax, so the rebuild idiom
    // {...frame, width: frame.width + 40} — where the tag arrives via the spread — is
    // recognized too.
    const contextual = context.checker.getContextualType(current)
    // Omitted optionals become explicit undefined values, keeping the invariant that a
    // record value carries every property its static type declares — a join between a
    // branch that set the property and one that omitted it must not drop it, and reads
    // must find the honest maybe-missing value rather than crash. (A literal with no
    // contextual record type has no optionals to fill.)
    const fillOptionalsFrom = (recordType: ts.Type): void => {
      for (const member of context.checker.getPropertiesOfType(recordType)) {
        if ((member.flags & ts.SymbolFlags.Optional) === 0 || lastByName.has(member.name)) continue
        const absent = addInstruction(context, current, {kind: 'nullishConstant', sentinel: 'undefined'})
        lastByName.set(member.name, {name: member.name, value: absent})
      }
    }
    // The contextual type may sit behind a nullable wrapper (`const config: Config |
    // null = flag ? {...} : null`): the literal builds the non-missing part, so the
    // filling and tag detection look through the wrapper at those members.
    const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    const contextMembers: readonly ts.Type[] = contextual == null
      ? []
      : contextual.isUnion()
        ? contextual.types.filter(member => (member.flags & missingFlags) === 0)
        : [contextual]
    if (contextMembers.length === 1 && valueKind(contextMembers[0]!, context.checker) === 'object') {
      fillOptionalsFrom(contextMembers[0]!)
    }
    let tag: {property: string; value: string | boolean} | null = null
    if (contextMembers.length > 1) {
      const tagProperty = taggedUnionProperty(contextMembers, context.checker)
      if (tagProperty != null) {
        const ownTag = context.checker.getPropertyOfType(context.checker.getTypeAtLocation(current), tagProperty)
        const ownTagType = ownTag == null ? null : context.checker.getTypeOfSymbol(ownTag)
        // The literal must pin ONE tag value ({ok: true}, {type: 'lightbox'}); a tag
        // written from a union-typed variable pins nothing and the value stays a record.
        const ownLiterals = ownTagType == null ? null : tagLiteralValues(ownTagType)
        const ownLiteral = ownLiterals != null && ownLiterals.length === 1 ? ownLiterals[0]! : null
        if (ownLiteral != null) {
          tag = {property: tagProperty, value: ownLiteral}
          // The variant's own optionals fill too — from every contextual member whose tag
          // values include this one, so a duplicate-tag literal covers both shapes'
          // optionals. Filling never breaks the in-check split: an optional property
          // reads as unknown presence either way.
          for (const member of contextMembers) {
            const memberTag = context.checker.getPropertyOfType(member, tagProperty)
            const memberTagType = memberTag == null ? null : context.checker.getTypeOfSymbol(memberTag)
            const memberLiterals = memberTagType == null ? null : tagLiteralValues(memberTagType)
            if (memberLiterals != null && memberLiterals.includes(ownLiteral)) {
              fillOptionalsFrom(member)
            }
          }
        }
      }
    }
    return addInstruction(context, current, {kind: 'object', properties: [...lastByName.values()], ...(tag == null ? {} : {tag})})
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
  if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
    return addInstruction(context, current, {kind: 'opaqueConstant'})
  }
  if (ts.isTemplateExpression(current)) {
    // `${width}px` — the interpolated expressions lower (they must be representable), the
    // result is carried without claims.
    for (const span of current.templateSpans) lowerExpression(span.expression, context)
    return addInstruction(context, current, {kind: 'opaqueConstant'})
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
    // `el instanceof HTMLDivElement` on a carried value: no narrowing (the analyzer does
    // not model classes), but the check itself is an effect-free operator, so it answers
    // unknown and both branches analyze — the function's other paths survive. The
    // declaration-file check is the same shadowing defense Math uses.
    if (current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && ts.isIdentifier(current.right)
      && declaredOnlyInDeclarationFiles(context.checker.getSymbolAtLocation(current.right))) {
      lowerExpression(current.left, context)
      return addInstruction(context, current, {kind: 'unknownBoolean'})
    }
    const tagComparison = tagCheckComparison(current, context)
    if (tagComparison != null) return tagComparison
    const presence = inCheckExpression(current, context)
    if (presence != null) return presence
    const opaqueComparison = opaqueEqualityCheck(current, context)
    if (opaqueComparison != null) return opaqueComparison
    // `width + 'px'`: string building with + is everywhere in UI code, and the template
    // spelling `${width}px` is already carried — when the checker types the result as a
    // string, the result is an opaque value. Both operands still lower, so an unsupported
    // construct inside one rejects as usual.
    if (current.operatorToken.kind === ts.SyntaxKind.PlusToken
      && valueKind(context.checker.getTypeAtLocation(current), context.checker) === 'opaque') {
      lowerExpression(current.left, context)
      lowerExpression(current.right, context)
      return addInstruction(context, current, {kind: 'opaqueConstant'})
    }
    const arithmetic = arithmeticOperator(current.operatorToken.kind)
    const comparison = comparisonOperator(current.operatorToken.kind)
    if (arithmetic == null && comparison == null) {
      throw unsupported(current, {kind: 'binaryOperator', operator: current.operatorToken.getText(context.sourceFile)})
    }
    // flag === true and flag !== other: booleans are modeled exactly, so equality over
    // them answers exactly too (the engine's compare arm dispatches on the operand kind).
    if ((comparison === 'equal' || comparison === 'notEqual')
      && valueKind(context.checker.getTypeAtLocation(current.left), context.checker) === 'boolean'
      && valueKind(context.checker.getTypeAtLocation(current.right), context.checker) === 'boolean') {
      const left = lowerExpression(current.left, context)
      const right = lowerExpression(current.right, context)
      return addInstruction(context, current, {kind: 'compare', operator: comparison, left, right})
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
      // Global parseFloat / parseInt / Number(x): honest NaN-carrying results, like their
      // Number.* spellings below (the declaration-file check defends against shadowing).
      const globalName = current.expression.text
      if ((globalName === 'parseFloat' || globalName === 'parseInt' || globalName === 'Number')
        && declaredOnlyInDeclarationFiles(context.checker.getSymbolAtLocation(current.expression))) {
        for (const argument of current.arguments) lowerExpression(argument, context)
        return addInstruction(context, current, {kind: 'parsedNumber', integer: globalName === 'parseInt'})
      }
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
      if (standardMath && (method === 'ceil' || method === 'round' || method === 'trunc' || method === 'sqrt')
        && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker)
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, current, {kind: 'mathUnary', operator: method, value})
      }
      if (standardMath && (method === 'min' || method === 'max') && current.arguments.length > 0) {
        for (const argument of current.arguments) requireNumberType(argument, context.checker)
        const values = current.arguments.map(argument => lowerExpression(argument, context))
        return addInstruction(context, current, {kind: method === 'min' ? 'minimum' : 'maximum', values})
      }
      // Number.isInteger / Number.isFinite: predicate checks whose branches narrow — the
      // missing halves of the bounds-check idiom (`i >= 0 && i < arr.length` proves the
      // range; Number.isInteger(i) proves the read hits an element rather than arr[1.5]).
      const standardNumber = isStandardNumberObject(current.expression.expression, context.checker)
      // Number.parseFloat / Number.parseInt: honest NaN sources — the result is any
      // number including NaN, and the isFinite/isNaN/isInteger narrowing downstream is
      // exactly what launders it. Arguments still lower (opaque strings carry).
      if (standardNumber && (method === 'parseFloat' || method === 'parseInt') && current.arguments.length >= 1) {
        for (const argument of current.arguments) lowerExpression(argument, context)
        return addInstruction(context, current, {kind: 'parsedNumber', integer: method === 'parseInt'})
      }
      if (standardNumber && (method === 'isInteger' || method === 'isFinite' || method === 'isNaN') && current.arguments.length === 1) {
        requireNumberType(current.arguments[0]!, context.checker)
        const value = lowerExpression(current.arguments[0]!, context)
        return addInstruction(context, current, {
          kind: 'numberCheck',
          predicate: method === 'isInteger' ? 'integer' : method === 'isFinite' ? 'finite' : 'nan',
          value,
        })
      }
      throw unsupported(current, {kind: 'call', callee: current.expression.getText(context.sourceFile)})
    }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const platform = platformFact(current, false, context.checker)
    if (platform != null) {
      return addInstruction(context, current, {kind: 'platformValue', ...platform})
    }
    // config?.volume: read when the receiver is present, undefined when missing — the
    // nullish machinery's value branch, with the true arm reading through the narrowed
    // receiver. Each ?. link carries its own check, so config?.inner?.volume works
    // link by link; the mixed spelling a?.b.c keeps rejecting at the .c receiver gate.
    if (current.questionDotToken != null) {
      const receiver = lowerExpression(current.expression, context)
      const present = addInstruction(context, current, {kind: 'nullishCheck', value: receiver, sentinel: 'nullish', negated: true})
      return lowerValueBranch(
        current,
        present,
        () => {
          // The branch refinement unwrapped the receiver's slot; the read must still
          // pass the same gates a plain read does, against the non-missing part.
          requireAccessedPropertyKind(current, context.checker)
          return addInstruction(context, current, {kind: 'property', object: receiver, property: current.name.text})
        },
        () => addInstruction(context, current, {kind: 'nullishConstant', sentinel: 'undefined'}),
        context,
      )
    }
    const objectType = context.checker.getTypeAtLocation(current.expression)
    const receiverKind = valueKind(objectType, context.checker)
    if ((receiverKind === 'array' || receiverKind === 'tuple') && current.name.text === 'length') {
      const array = lowerExpression(current.expression, context)
      return addInstruction(context, current, {kind: 'arrayLength', array})
    }
    // A string's length is the one modeled read on an opaque string: a fresh nonnegative
    // integer (each read fresh — two reads of the same string relate only through a
    // local, the same freshness story as element reads). Every other string property
    // keeps rejecting below.
    if (receiverKind === 'opaque' && current.name.text === 'length'
      && (objectType.flags & ts.TypeFlags.StringLike) !== 0) {
      lowerExpression(current.expression, context)
      return addInstruction(context, current, {kind: 'stringLength'})
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
    // while index signatures, callables, and mixed shapes reject. A tagged-union receiver
    // reads too: the engine answers reads of the tag and of properties every variant
    // carries, and stops honestly on a partial property no check narrowed first.
    if (receiverKind !== 'object' && receiverKind !== 'taggedUnion') {
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
  | {form: 'logical'; target: ts.Identifier; node: ts.BinaryExpression; logical: 'nullish' | 'or' | 'and'}
  | {form: 'update'; target: ts.Identifier; node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression}

export function identifierAssignment(node: ts.Node): IdentifierAssignment | null {
  if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
    if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) return {form: 'assign', target: node.left, node}
    const operator = compoundAssignmentOperator(node.operatorToken.kind)
    if (operator != null) return {form: 'compound', target: node.left, node, operator}
    const logical = node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken ? 'nullish'
      : node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ? 'or'
      : node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ? 'and'
      : null
    if (logical != null) return {form: 'logical', target: node.left, node, logical}
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
  // `if (result.ok)` where ok is a boolean-valued tag: truthiness of the tag IS the
  // tag check against true, so the branches narrow the variant list exactly like the
  // `result.ok === true` spelling. Only boolean tags take this route — a string tag's
  // truthiness would additionally hinge on the empty string, which requireBooleanCondition
  // rejects anyway.
  const tagUnion = taggedUnionTagRead(current, context)
  const condition = tagUnion != null
    ? addInstruction(context, current, {kind: 'tagCheck', union: lowerExpression(tagUnion, context), tagValue: true, negated: false})
    : lowerExpression(current, context)
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
    case ts.SyntaxKind.PercentToken: return 'remainder'
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
    // Loose != on two numbers is exactly strict !== (no coercion between numbers); the
    // nullish and opaque spellings of both tokens are claimed by their own handlers
    // before the operator classification runs.
    case ts.SyntaxKind.ExclamationEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return 'notEqual'
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
export function valueKind(type: ts.Type, checker: ts.TypeChecker, depth = 0): 'number' | 'boolean' | 'object' | 'nullable' | 'array' | 'tuple' | 'opaque' | 'taggedUnion' | null {
  // The depth guard bounds recursion into element types (a recursive `type T = T[]` would
  // otherwise loop); past it, nothing classifies.
  if (depth > 8) return null
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 'number'
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean'
  // Strings are carried without claims: a label or id must not reject the numeric
  // contract of the function around it.
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return 'opaque'
  // The type system's own split, mirrored: tuple types are positional and exact, array
  // types are homogeneous. Checked before the general object arm (both carry the Object
  // flag and index signatures). An array classifies only when its ELEMENT does — a
  // (number | boolean)[] value's element hull is nothing any read gate could describe.
  if (checker.isTupleType(type)) return 'tuple'
  if (checker.isArrayType(type)) {
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    return element != null && valueKind(element, checker, depth + 1) != null ? 'array' : null
  }
  // Object types and intersections of object types (`Base & {subPage: 'select'}` — the
  // extends idiom for route variants) run the same classification: the checker's property
  // and signature queries answer for an intersection's merged view, so one body serves
  // both. A member outside the object kind keeps the whole intersection out.
  const objectLike = (type.flags & ts.TypeFlags.Object) !== 0
    || (type.isIntersection() && type.types.every(member => valueKind(member, checker, depth + 1) === 'object'))
  if (objectLike) {
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
    if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
      // A pure function type — call signatures and nothing else — is carried opaquely,
      // like a callback stored in a record already is: calls to it reject at the call
      // gate (the callee must be a top-level function), so carrying makes callback
      // PARAMETERS as cheap as callback properties. Hybrid callable-objects keep out:
      // their data properties would invite reads the carried value cannot answer.
      const dataProperties = checker.getPropertiesOfType(type).some(property =>
        checker.getTypeOfSymbol(property).getCallSignatures().length === 0)
      return dataProperties ? null : 'opaque'
    }
    // Optional properties anchor too, now that they model as maybe-undefined values: an
    // all-optional config record ({volume?: number}) is a weak type TypeScript refuses to
    // assign primitives to, so the primitive-inhabitation worry that bars `{}` does not
    // apply — only a type with NO data properties at all stays out.
    const anchored = checker.getPropertiesOfType(type).some(property =>
      checker.getTypeOfSymbol(property).getCallSignatures().length === 0)
    return anchored ? 'object' : null
  }
  // `unknown` is the SAFE any: the checker forces narrowing before any use, so its word
  // stays intact and the value carries without claims — unlike `any`, which stays out.
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return 'opaque'
  if (type.isUnion()) {
    // `T | null`, `T | undefined`, and `T | null | undefined` classify as nullable when T
    // itself classifies to one kind. Gates that cannot carry a missing value keep
    // rejecting ('nullable' matches neither 'number' nor 'object'); kind-agnostic gates
    // (declarators, ternary results, destructure elements, returns) accept.
    const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    if (type.types.some(member => (member.flags & missingFlags) !== 0)) {
      const rest = type.types.filter(member => (member.flags & missingFlags) === 0)
      // The non-missing rest classifies as a group, so `4 | 8 | 24 | undefined` — an
      // as-const table's bare dynamic read — is nullable like `number | undefined`. A
      // rest that is itself a tagged union (`null | LightboxOwnerRoute`) is nullable too.
      const restKind = classifyUnionMembers(rest, checker, depth + 1)
      if (restKind != null) return 'nullable'
      return taggedUnionProperty(rest, checker, depth) == null ? null : 'nullable'
    }
    // A shared string-literal property makes the union tagged — checked BEFORE the
    // shared-shape classification, because route variants that differ only by tag value
    // (or only by properties an in-check splits) must not collapse into one merged
    // record whose tag check narrows nothing. Unions without a tag fall back to the
    // shared-kind rule (identical-shape aliases, literal unions, and friends).
    if (taggedUnionProperty(type.types, checker, depth) != null) return 'taggedUnion'
    return classifyUnionMembers(type.types, checker, depth + 1)
  }
  return null
}

// The property that tells a union of record shapes apart: present and required in every
// member, typed as a single string literal in each. The first property (in the first
// member's declaration order) that qualifies wins — by convention the tag comes first
// (`type: 'lightbox'`). Two members MAY share a tag value (`{type: 'updates'; tab} |
// {type: 'updates'; article}`): a tag check then keeps both, and telling them apart takes
// an `in` check, exactly as it does in TypeScript's own narrowing. Null when no property
// qualifies.
export function taggedUnionProperty(members: readonly ts.Type[], checker: ts.TypeChecker, depth = 0): string | null {
  if (members.length < 2) return null
  for (const member of members) {
    if (valueKind(member, checker, depth + 1) !== 'object') return null
  }
  // Two passes: a property whose tag is a SINGLE literal per member (`ok: true` /
  // `ok: false`, `type: 'lightbox'`) is a real discriminant and wins first. Only then do
  // multi-literal tags qualify (`type: 'desktopCollapsedNav' | 'desktopExpandedNav'` in
  // one variant, or a plain boolean property every member carries) — otherwise a
  // non-discriminating `enabled: boolean` shared by all members could shadow the actual
  // tag declared after it.
  const first = members[0]!
  const qualifies = (candidateName: string, singleLiteralOnly: boolean): boolean => {
    for (const member of members) {
      const property = checker.getPropertyOfType(member, candidateName)
      if (property == null || (property.flags & ts.SymbolFlags.Optional) !== 0) return false
      const literals = tagLiteralValues(checker.getTypeOfSymbol(property))
      if (literals == null || (singleLiteralOnly && literals.length !== 1)) return false
    }
    return true
  }
  for (const singleLiteralOnly of [true, false]) {
    for (const candidate of checker.getPropertiesOfType(first)) {
      if ((candidate.flags & ts.SymbolFlags.Optional) !== 0) continue
      if (qualifies(candidate.name, singleLiteralOnly)) return candidate.name
    }
  }
  return null
}

// The literal tag values a tag property's type covers: a string or boolean literal gives
// one, a union of such literals gives one per member — and `ok: boolean` arrives here as
// the checker's `true | false` union, so it gives both. Null when any member is not such
// a literal (a number tag, a full string). The list is bounded by what the author wrote
// in the type.
export function tagLiteralValues(type: ts.Type): Array<string | boolean> | null {
  const single = (member: ts.Type): string | boolean | null => {
    if (member.isStringLiteral()) return member.value
    if ((member.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return (member as unknown as {intrinsicName: string}).intrinsicName === 'true'
    }
    return null
  }
  const members = type.isUnion() ? type.types : [type]
  const literals: Array<string | boolean> = []
  for (const member of members) {
    const literal = single(member)
    if (literal == null) return null
    literals.push(literal)
  }
  return literals
}

// One shared kind for a group of union members, or null. Object, array, and tuple members
// must additionally agree on their recursive shape fingerprints: TypeScript normalizes a
// union of disjoint record shapes by adding each member's missing properties as
// optional-undefined, so only the required properties describe the member's real shape,
// and the property KINDS are part of it recursively — a discriminated union like
// {ok: true; value: number} | {ok: false; value: boolean} has one name set but two
// meanings for `value`. Members admitted here join losslessly (matching fingerprints mean
// matching names and kinds at every depth), so every read the union's type exposes stays
// answerable — including reads of array-typed properties on identically-shaped aliases,
// which TypeScript keeps as a union at the read position.
function classifyUnionMembers(
  members: readonly ts.Type[],
  checker: ts.TypeChecker,
  depth: number,
): 'number' | 'boolean' | 'object' | 'array' | 'tuple' | 'opaque' | null {
  if (depth > 8) return null
  let shared: 'number' | 'boolean' | 'object' | 'array' | 'tuple' | 'opaque' | null = null
  let sharedShape: string | null = null
  for (const member of members) {
    const kind = valueKind(member, checker, depth)
    // A nullable or tagged-union member cannot arise here (TypeScript flattens nested
    // unions), but the type system cannot see that; both fail the shared-kind rule.
    if (kind == null || kind === 'nullable' || kind === 'taggedUnion' || (shared != null && kind !== shared)) return null
    if (kind === 'object' || kind === 'array' || kind === 'tuple') {
      const shape = shapeFingerprint(member, checker, [])
      if (shape == null || (sharedShape != null && shape !== sharedShape)) return null
      sharedShape = shape
    }
    shared = kind
  }
  return shared
}

// The recursive shape of an object type: property names with their kinds, nested records
// spelled out in full. Two union members agree only when their fingerprints are equal.
// 'other' labels a kind the analysis cannot represent; 'other' matches 'other', which is
// safe not because such values cannot exist — a property typed
// {width: number} | {code: number} is 'other' and its values are ordinary literals — but
// because every read of an 'other' property is gated: direct access and destructuring
// gate the result type through valueKind, spreads gate each copied property, and a read
// the gates admit against a value the walk carried opaquely stops at the kind-mismatch
// backstop. A fingerprint the seen set or depth cap CUT SHORT is different: below the cutoff
// there can be readable properties the comparison never saw (discriminant narrowing types
// deep reads against a single member), so a truncated fingerprint is null and never
// compares equal — the union is rejected, mirroring how the module shape walk goes opaque
// at its cap.
function shapeFingerprint(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): string | null {
  // An intersection fingerprints by its merged property view — the checker's property
  // queries already answer for the whole intersection — so two route variants written as
  // Base & {...} get DIFFERENT fingerprints and their union classifies as tagged instead
  // of collapsing into one merged record whose tag check narrows nothing.
  if (type.isIntersection() && valueKind(type, checker) === 'object') {
    if (seen.length >= 8 || seen.includes(type)) return null
    const parts: string[] = []
    for (const property of checker.getPropertiesOfType(type)) {
      if ((property.flags & ts.SymbolFlags.Optional) !== 0) continue
      const propertyShape = shapeFingerprint(checker.getTypeOfSymbol(property), checker, [...seen, type])
      if (propertyShape == null) return null
      parts.push(`${property.name}:${propertyShape}`)
    }
    return `{${parts.sort().join(',')}}`
  }
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return 'number'
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean'
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return 'opaque'
  // Arrays and tuples fingerprint by their element shapes: {items: number[]} and
  // {items: boolean[]} are different shapes, or the join would drop a property the read
  // gates still expose.
  if (checker.isTupleType(type)) {
    if (seen.length >= 8 || seen.includes(type)) return null
    const positions: string[] = []
    for (const elementType of checker.getTypeArguments(type as ts.TypeReference)) {
      const position = shapeFingerprint(elementType, checker, [...seen, type])
      if (position == null) return null
      positions.push(position)
    }
    return `tuple{${positions.join(',')}}`
  }
  if (checker.isArrayType(type)) {
    if (seen.length >= 8 || seen.includes(type)) return null
    const elementType = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    if (elementType == null) return 'other'
    const element = shapeFingerprint(elementType, checker, [...seen, type])
    return element == null ? null : `array{${element}}`
  }
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
  // `unknown` is the SAFE any: the checker forces narrowing before any use, so its word
  // stays intact and the value carries without claims — unlike `any`, which stays out.
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return 'opaque'
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
  // An optional property reads as its maybe-undefined value: declared kinds wrap it in
  // the undefined sentinel and object literals fill omitted ones explicitly, so a record
  // value always carries every property its static type declares — there is always
  // something honest to read.
  const receiverType = checker.getTypeAtLocation(access.expression)
  // For an optional read the receiver includes the missing sentinels; the property lives
  // on the non-missing part, which getNonNullableType strips to.
  const presentType = access.questionDotToken != null ? checker.getNonNullableType(receiverType) : receiverType
  const property = checker.getPropertyOfType(presentType, access.name.text)
  // point.toString type-checks on every object literal, but the record value carries only
  // its own properties — an inherited prototype member has no honest answer. The
  // ownership test is the .d.ts rule: a property symbol declared only in declaration
  // files was not written by the project, and on a project record that means prototype.
  if (valueKind(presentType, checker) === 'object' && property != null && declaredOnlyInDeclarationFiles(property)) {
    throw unsupported(access, {kind: 'prototypeMemberRead', property: access.name.text})
  }
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
  return declaredOnlyInDeclarationFiles(checker.getSymbolAtLocation(expression))
}

function isStandardNumberObject(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'Number') return false
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

// A read of the union's tag property (`route.type` where route is one of several
// shapes): the recognizer both the === form and the switch subject share. Returns the
// union expression, or null when the expression is not a tag read.
export function taggedUnionTagRead(expression: ts.Expression, context: FunctionContext): ts.Expression | null {
  const unwrapped = unwrap(expression, context.checker)
  if (!ts.isPropertyAccessExpression(unwrapped)) return null
  const objectType = context.checker.getTypeAtLocation(unwrapped.expression)
  if (valueKind(objectType, context.checker) !== 'taggedUnion' || !objectType.isUnion()) return null
  const tagProperty = taggedUnionProperty(objectType.types, context.checker)
  return tagProperty === unwrapped.name.text ? unwrapped.expression : null
}

// route.type === 'lightbox' (and !==, the loose spellings, and result.ok === true): the
// check consumes the union value directly and the branches narrow its variant list — the
// same move the null checks make, pointed at the tag. The compared side must be a string
// or boolean literal; comparing two tag reads to each other stays an unknown boolean
// through the opaque path.
function tagCheckComparison(expression: ts.BinaryExpression, context: FunctionContext): ValueID | null {
  const operator = expression.operatorToken.kind
  const equals = operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken
  const notEquals = operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken
  if (!equals && !notEquals) return null
  const literalOf = (side: ts.Expression): string | boolean | null => {
    const unwrapped = unwrap(side, context.checker)
    if (ts.isStringLiteral(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text
    if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true
    if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false
    return null
  }
  const sides = [
    {union: taggedUnionTagRead(expression.left, context), literal: literalOf(expression.right)},
    {union: taggedUnionTagRead(expression.right, context), literal: literalOf(expression.left)},
  ]
  for (const side of sides) {
    if (side.union != null && side.literal != null) {
      const union = lowerExpression(side.union, context)
      return addInstruction(context, expression, {kind: 'tagCheck', union, tagValue: side.literal, negated: notEquals})
    }
  }
  return null
}

// `'tab' in route` on a tagged union: the branches split the variants that declare the
// property from those that do not. Any other use of `in` stays rejected (the binary
// operator catch-all): on a plain record the answer is always yes for declared
// properties, and dynamic keys are outside the subset.
function inCheckExpression(expression: ts.BinaryExpression, context: FunctionContext): ValueID | null {
  if (expression.operatorToken.kind !== ts.SyntaxKind.InKeyword) return null
  const key = unwrap(expression.left, context.checker)
  if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return null
  const objectType = context.checker.getTypeAtLocation(expression.right)
  if (valueKind(objectType, context.checker) !== 'taggedUnion') return null
  const union = lowerExpression(expression.right, context)
  return addInstruction(context, expression, {kind: 'inCheck', union, property: key.text})
}

// `mode === 'compact'`: comparing two carried-without-claims values yields a boolean the
// analysis knows nothing about — both branches stay analyzed, which is sound and keeps
// string-keyed control flow from rejecting the function. A possibly-missing string
// qualifies too (`mode === 'wide'` where mode is string | undefined): a missing value
// simply compares unequal, so the unknown-boolean result stays sound without a null guard
// first. The operands still lower, so an unsupported construct inside one rejects as
// usual. This check runs AFTER missingSentinelCheck, so `mode === null` is already claimed
// by the sentinel narrowing before either side is classified here.
function opaqueEqualityCheck(expression: ts.BinaryExpression, context: FunctionContext): ValueID | null {
  const operator = expression.operatorToken.kind
  const isEquality = operator === ts.SyntaxKind.EqualsEqualsEqualsToken
    || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || operator === ts.SyntaxKind.EqualsEqualsToken
    || operator === ts.SyntaxKind.ExclamationEqualsToken
  if (!isEquality) return null
  const opaqueOrMissingOpaque = (side: ts.Expression): boolean => {
    const type = context.checker.getTypeAtLocation(side)
    const kind = valueKind(type, context.checker)
    if (kind === 'opaque') return true
    if (kind === 'nullable' && type.isUnion()) {
      const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
      const rest = type.types.filter(member => (member.flags & missing) === 0)
      return rest.length >= 1 && rest.every(member => valueKind(member, context.checker) === 'opaque')
    }
    return false
  }
  if (!opaqueOrMissingOpaque(expression.left) || !opaqueOrMissingOpaque(expression.right)) return null
  lowerExpression(expression.left, context)
  lowerExpression(expression.right, context)
  return addInstruction(context, expression, {kind: 'unknownBoolean'})
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
    if (isUndefinedGlobal(unwrapped, context.checker)) return 'undefined'
    return null
  }
  // `typeof x === 'undefined'` is the classic guard spelling; it is the undefined
  // sentinel check with the checked side inside the typeof.
  const isUndefinedString = (side: ts.Expression): boolean => {
    const unwrapped = unwrap(side, context.checker)
    return ts.isStringLiteral(unwrapped) && unwrapped.text === 'undefined'
  }
  if (ts.isTypeOfExpression(expression.left) && isUndefinedString(expression.right)) {
    const value = lowerExpression(expression.left.expression, context)
    return addInstruction(context, expression, {kind: 'nullishCheck', value, sentinel: 'undefined', negated})
  }
  if (ts.isTypeOfExpression(expression.right) && isUndefinedString(expression.left)) {
    const value = lowerExpression(expression.right.expression, context)
    return addInstruction(context, expression, {kind: 'nullishCheck', value, sentinel: 'undefined', negated})
  }
  // `typeof x === 'number'` (or 'string', or 'boolean') on a value whose only
  // non-missing kind matches the literal equals "x is not missing" — the common
  // narrowing spelling for number | undefined and friends. Which analyzer kind each
  // typeof answer names:
  const typeofKinds: Record<string, 'number' | 'opaque' | 'boolean'> = {
    number: 'number',
    string: 'opaque',
    boolean: 'boolean',
  }
  const typeofLiteral = (side: ts.Expression): string | null => {
    const unwrapped = unwrap(side, context.checker)
    return ts.isStringLiteral(unwrapped) && typeofKinds[unwrapped.text] != null ? unwrapped.text : null
  }
  const typeofSide = ts.isTypeOfExpression(expression.left) && typeofLiteral(expression.right) != null
    ? {operand: expression.left, literal: typeofLiteral(expression.right)!}
    : ts.isTypeOfExpression(expression.right) && typeofLiteral(expression.left) != null
      ? {operand: expression.right, literal: typeofLiteral(expression.left)!}
      : null
  if (typeofSide != null) {
    const operandType = context.checker.getTypeAtLocation(typeofSide.operand.expression)
    // The TYPE FLAGS decide, not the analyzer kind: unknown classifies opaque like
    // strings do, but typeof unknown === 'string' is genuinely unknown — treating the
    // kinds as equivalent would answer it definitely-true. Only when every non-missing
    // member's flags name the checked primitive does the check translate to
    // "not missing"; everything else (unknown operands, mixed unions) answers an
    // unknown boolean — typeof is an effect-free operator, so both branches analyzing
    // is always sound.
    const wantedFlags: Record<string, ts.TypeFlags> = {
      number: ts.TypeFlags.NumberLike,
      string: ts.TypeFlags.StringLike,
      boolean: ts.TypeFlags.BooleanLike,
    }
    const wanted = wantedFlags[typeofSide.literal]!
    const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    const members = operandType.isUnion() ? operandType.types : [operandType]
    const restMatches = members.every(member =>
      (member.flags & missing) !== 0 || (member.flags & wanted) !== 0)
    && members.some(member => (member.flags & missing) === 0)
    const value = lowerExpression(typeofSide.operand.expression, context)
    if (restMatches) {
      return addInstruction(context, expression, {kind: 'nullishCheck', value, sentinel: 'nullish', negated: !negated})
    }
    return addInstruction(context, expression, {kind: 'unknownBoolean'})
  }
  const leftSentinel = sentinelOf(expression.left)
  const rightSentinel = sentinelOf(expression.right)
  const sentinel = leftSentinel ?? rightSentinel
  if (sentinel == null || (leftSentinel != null && rightSentinel != null)) return null
  const checked = leftSentinel == null ? expression.left : expression.right
  // The checked side must be a kind the analysis represents: `voidCall() == null` is TRUE
  // at runtime (a void function returns undefined), but the void abstract value carries no
  // sentinel, so admitting it would prune the wrong branch. A pure-sentinel type
  // (`null | undefined`, after an outer `== null` narrowed everything else away) is fine:
  // the abstract value carries exactly those sentinels.
  const checkedType = context.checker.getTypeAtLocation(checked)
  const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
  const pureSentinel = (checkedType.flags & missingFlags) !== 0
    || (checkedType.isUnion() && checkedType.types.every(member => (member.flags & missingFlags) !== 0))
  if (!pureSentinel && valueKind(checkedType, context.checker) == null) {
    throw unsupported(checked, {kind: 'valueType', typeText: context.checker.typeToString(checkedType)})
  }
  const value = lowerExpression(checked, context)
  return addInstruction(context, expression, {
    kind: 'nullishCheck',
    value,
    sentinel: loose ? 'nullish' : sentinel,
    negated,
  })
}

// The intrinsic `undefined` symbol has ZERO declarations (no `declare var undefined` in
// lib), so the declaration-file shadowing defense cannot recognize it. The type is the
// defense instead: only the real global's type carries the Undefined flag — a shadowing
// binding's type is whatever it was assigned.
function isUndefinedGlobal(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== 'undefined') return false
  return (checker.getTypeAtLocation(expression).flags & ts.TypeFlags.Undefined) !== 0
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
  if (isUndefinedGlobal(node, context.checker)) {
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
