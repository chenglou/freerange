import * as ts from 'typescript'
import type {ValueID} from '../ir/ids.ts'
import type {ComparisonOperator, InstructionIR} from '../ir/instructions.ts'
import type {StaticAssertionProblem} from '../ir/program.ts'
import {numberConstituent} from './numeric-intersection.ts'
import {
  declaredOnlyInDeclarationFiles,
  hasDefaultLibraryDeclaration,
  platformFact,
} from './platform.ts'
import {
  addInstruction,
  addInstructionAtSite,
  addSite,
  createBlock,
  requiredSymbol,
  terminate,
  unsupported,
  type FunctionContext,
} from './context.ts'
import type {StaticAnnotation} from './static-intrinsics.ts'
import {isUndefinedGlobal, numericLiteralValue, parameterDefaultLiteral, type ParameterDefaultLiteral} from './literals.ts'

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
          const targetKind = valueKind(targetType, context.checker)
          if (targetKind !== 'boolean') {
            throw unsupported(assignment.target, {
              kind: 'nonBooleanCondition',
              conditionKind: targetKind === 'number' ? 'number' : 'other',
              typeText: context.checker.typeToString(targetType),
            })
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
          && (context.checker.getTypeAtLocation(current).flags & ts.TypeFlags.StringLike) !== 0) {
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
  if (ts.isPrefixUnaryExpression(current) && current.operator === ts.SyntaxKind.PlusToken) {
    const positive = unwrap(current.operand, context.checker)
    if (ts.isNumericLiteral(positive)) {
      return addInstruction(context, current, {kind: 'constant', value: Number(positive.text)})
    }
    throw unsupported(current, {kind: 'expressionForm', syntax: ts.SyntaxKind[current.kind]})
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
    if (isStandardGlobal(negated, 'Infinity', context)) {
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
    // Map insertion order keeps the first position while set keeps the last value, which
    // matches object-literal evaluation and overwrite order.
    const properties = new Map<string, {name: string; value: ValueID}>()
    for (const property of current.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        const symbol = context.checker.getShorthandAssignmentValueSymbol(property)
        if (symbol == null) throw unsupported(property, {kind: 'missingSymbol'})
        properties.set(property.name.text, {
          name: property.name.text,
          value: identifierValue(symbol, property.name, context),
        })
        continue
      }
      if (ts.isPropertyAssignment(property)) {
        const name = propertyName(property.name)
        // `__proto__: value` in a literal is prototype-setting syntax at runtime — no own
        // property is created — while the checker types it as a plain property.
        if (name === '__proto__') throw unsupported(property, {kind: 'protoProperty'})
        properties.set(name, {name, value: lowerExpression(property.initializer, context)})
        continue
      }
      if (ts.isSpreadAssignment(property)) throw unsupported(property, {kind: 'objectSpread'})
      throw unsupported(property, {kind: 'objectPropertyForm'})
    }
    // A literal written where a tagged union is expected ({type: 'sidebar', width: 240}
    // returned as Frame) records which variant it builds, so branches building different
    // variants join per tag instead of dropping every mismatched property. The tag VALUE
    // comes from the literal's own checked type, not its syntax, so the rebuild idiom
    // {type: frame.type, width: frame.width + 40} — where the tag arrives via a property
    // read of the narrowed union — is recognized too.
    const contextual = context.checker.getContextualType(current)
    // Omitted optionals become explicit undefined values, keeping the invariant that a
    // record value carries every property its static type declares — a join between a
    // branch that set the property and one that omitted it must not drop it, and reads
    // must find the honest maybe-missing value rather than crash. (A literal with no
    // contextual record type has no optionals to fill.)
    const fillOptionalsFrom = (recordType: ts.Type): void => {
      for (const member of context.checker.getPropertiesOfType(recordType)) {
        if ((member.flags & ts.SymbolFlags.Optional) === 0 || properties.has(member.name)) continue
        const absent = addInstruction(context, current, {kind: 'nullishConstant', sentinel: 'undefined'})
        properties.set(member.name, {name: member.name, value: absent})
      }
    }
    // The contextual type may sit behind a nullable wrapper (`const config: Config |
    // null = flag ? {...} : null`): the literal builds the non-missing part, so the
    // filling and tag detection look through the wrapper at those members.
    const contextMembers: readonly ts.Type[] = contextual == null
      ? []
      : contextual.isUnion()
        ? nonMissingUnionMembers(contextual)
        : [contextual]
    if (contextMembers.length === 1 && valueKind(contextMembers[0]!, context.checker) === 'object') {
      fillOptionalsFrom(contextMembers[0]!)
    }
    let tag: {property: string} | null = null
    if (contextMembers.length > 1) {
      const tagProperty = taggedUnionProperty(contextMembers, context.checker)
      if (tagProperty != null) {
        // WHICH property is the tag comes from the type (a property name carries no
        // claim); WHICH VARIANT the literal builds is decided by the engine from the tag
        // property's runtime-tracked value, never from the checker's type of the tag —
        // the type channel is assertion-taintable at any distance (a review round chained
        // `{kind: raw as 'lightbox'}`, its quoted-key spelling, and a spread of a
        // cast-tagged template), while value-carried content only ever originates from
        // written literals and declared-variant seeding.
        tag = {property: tagProperty}
        // Optional filling still needs the tag value at lowering; a literal WRITTEN in
        // the tag position provides it (the same trust rule tag-check comparisons and
        // switch labels follow). The variant's own optionals fill from every contextual
        // member whose tag values include the written one, so a duplicate-tag literal
        // covers both shapes' optionals. An optional property reads as possibly undefined
        // either way.
        const ownLiteral = writtenTagLiteral(current, tagProperty, context)
        if (ownLiteral != null) {
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
    return addInstruction(context, current, {kind: 'object', properties: [...properties.values()], ...(tag == null ? {} : {tag})})
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
    // The exact text rides along: its one consumer is the tagged-union variant pin, which
    // trusts only value-carried content (see the engine's object arm).
    return addInstruction(context, current, {kind: 'opaqueConstant', content: current.text})
  }
  // Any assertion except `as const` (which unwrap peels). The operand still lowers (an
  // unsupported construct inside it rejects as usual), but its claims are erased:
  // downstream sees a claim-free value whose uses stop at the gates and whose joins
  // absorb, which is what keeps `true as unknown as number` — and every comparability
  // spelling of the same launder — from carrying a boolean into number positions.
  if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
    lowerExpression(current.expression, context)
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
    // The true arm uses the left value refined by the nullish check.
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
    // A declaration-file constructor is opaque but safe to test; a local constructor is
    // runtime code outside the accepted subset.
    if (current.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
      && ts.isIdentifier(current.right)
      && declaredOnlyInDeclarationFiles(context.checker.getSymbolAtLocation(current.right))) {
      lowerExpression(current.left, context)
      return addInstruction(context, current, {kind: 'unknownBoolean'})
    }
    const tagComparison = tagCheckComparison(current, context)
    if (tagComparison != null) return tagComparison
    const opaqueComparison = opaqueEqualityCheck(current, context)
    if (opaqueComparison != null) return opaqueComparison
    // `width + 'px'`: string building with + is everywhere in UI code, and the template
    // spelling `${width}px` is already carried — when the checker types the result as a
    // string, the result is an opaque value. Both operands still lower, so an unsupported
    // construct inside one rejects as usual.
    if (current.operatorToken.kind === ts.SyntaxKind.PlusToken
      && (context.checker.getTypeAtLocation(current).flags & ts.TypeFlags.StringLike) !== 0) {
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
    const staticAnnotation = context.staticAnnotations.get(current)
    if (staticAnnotation != null) return lowerStaticAnnotation(staticAnnotation, context)
    if (ts.isIdentifier(current.expression)) {
      // Global parseFloat / parseInt / Number(x): honest NaN-carrying results, like their
      // Number.* spellings below. Standard-library identity defends against shadows and
      // project declarations that merely reuse a built-in name.
      const globalName = current.expression.text
      if ((globalName === 'parseFloat' || globalName === 'parseInt' || globalName === 'Number')
        && isStandardGlobal(current.expression, globalName, context)) {
        for (const argument of current.arguments) lowerExpression(argument, context)
        return addInstruction(context, current, {kind: 'parsedNumber', integer: globalName === 'parseInt'})
      }
      const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(current.expression), context.checker)
      const callee = symbol == null ? undefined : context.functionsBySymbol.get(symbol)
      if (callee == null) throw unsupported(current, {kind: 'call', callee: current.expression.text})
      if (current.arguments.length > callee.declaration.parameters.length) {
        throw unsupported(current, {kind: 'callWithMoreArguments', callee: current.expression.text})
      }
      const arguments_: ValueID[] = []
      for (let index = 0; index < callee.declaration.parameters.length; index++) {
        const parameter = callee.declaration.parameters[index]!
        const argument = current.arguments[index]
        if (argument == null) {
          if (parameter.initializer != null) {
            const default_ = parameterDefaultLiteral(parameter.initializer, context.checker)
            if (default_ == null) {
              throw unsupported(current, {kind: 'callWithFewerArguments', callee: current.expression.text})
            }
            arguments_.push(lowerParameterDefault(default_, parameter.initializer, context))
            continue
          }
          const callableParameter = callee.signature?.declaration?.parameters[index]
          if (callableParameter != null
            && ts.isParameter(callableParameter)
            && callableParameter.questionToken != null) {
            arguments_.push(addInstruction(context, parameter, {kind: 'nullishConstant', sentinel: 'undefined'}))
            continue
          }
          throw unsupported(current, {kind: 'callWithFewerArguments', callee: current.expression.text})
        }
        const value = lowerExpression(argument, context)
        const default_ = parameter.initializer == null
          ? null
          : parameterDefaultLiteral(parameter.initializer, context.checker)
        if (default_ == null
          || !typeCanIncludeUndefined(context.checker.getTypeAtLocation(argument))) {
          arguments_.push(value)
          continue
        }
        // JavaScript applies a parameter default when the supplied value is undefined,
        // not only when the argument is omitted. The normal value-producing branch keeps
        // that rule exact for `number | undefined` arguments without a new IR operation.
        const supplied = addInstruction(context, argument, {
          kind: 'nullishCheck',
          value,
          sentinel: 'undefined',
          negated: true,
        })
        arguments_.push(lowerValueBranch(
          argument,
          supplied,
          () => value,
          () => lowerParameterDefault(default_, parameter.initializer!, context),
          context,
        ))
      }
      return addInstruction(context, current, {
        kind: 'call',
        function: callee.id,
        arguments: arguments_,
        binding: callee.binding,
      })
    }
    if (ts.isPropertyAccessExpression(current.expression)) {
      const platformCall = current.arguments.length === 0
        ? platformFact(current.expression, true, context.checker, context.program)
        : null
      if (platformCall != null) {
        return addInstruction(context, current, {kind: 'platformValue', ...platformCall})
      }
      const method = current.expression.name.text
      const standardMath = isStandardGlobal(current.expression.expression, 'Math', context)
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
      const standardNumber = isStandardGlobal(current.expression.expression, 'Number', context)
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
      const arrayMethod = ts.isPropertyAccessExpression(current.expression)
        && context.checker.isArrayType(context.checker.getTypeAtLocation(current.expression.expression))
        ? current.expression.name.text === 'reduce' ? 'reduce' : 'other'
        : null
      throw unsupported(current, {
        kind: 'call',
        callee: calleeDisplayName(current.expression, context.sourceFile),
        ...(arrayMethod == null ? {} : {arrayMethod}),
      })
    }
  }
  if (ts.isPropertyAccessExpression(current)) {
    const platform = platformFact(current, false, context.checker, context.program)
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
    // A string's length is the one modeled read on an opaque string. Carry the immutable
    // receiver so repeated reads can be recognized as the same number.
    if (receiverKind === 'opaque' && current.name.text === 'length'
      && (objectType.flags & ts.TypeFlags.StringLike) !== 0) {
      const value = lowerExpression(current.expression, context)
      return addInstruction(context, current, {kind: 'stringLength', value})
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

function lowerStaticAnnotation(annotation: StaticAnnotation, context: FunctionContext): ValueID {
  if (annotation.kind === 'invalid') {
    throw unsupported(annotation.node, {kind: 'staticAssertionForm', problem: annotation.problem})
  }
  const condition = annotation.condition
  requireBooleanCondition(condition, context.checker)
  const originalBlock = context.currentBlock
  const originalBlockCount = context.blocks.length
  const originalInstructionCount = originalBlock.instructions.length
  let value: ValueID
  if (annotation.role === 'requirement') {
    const requirement = writtenRequirement(condition, context)
    if (requirement == null) {
      throw unsupported(condition, {
        kind: 'staticAssertionForm',
        problem: staticAssertionProblem(condition, context, 'callerRequirement'),
      })
    }
    value = lowerWrittenRequirement(requirement, condition, context)
  } else {
    if (!supportedWrittenAssertion(condition, context)) {
      throw unsupported(condition, {
        kind: 'staticAssertionForm',
        problem: staticAssertionProblem(condition, context, 'directCheck'),
      })
    }
    value = lowerExpression(condition, context)
  }
  if (context.currentBlock !== originalBlock || context.blocks.length !== originalBlockCount) {
    throw unsupported(condition, {kind: 'staticAssertionForm', problem: 'bindValueFirst'})
  }
  const conditionInstructions = originalBlock.instructions.slice(originalInstructionCount)
  if (conditionInstructions.some(instruction => !removableStaticConditionInstruction(instruction))) {
    throw unsupported(condition, {kind: 'staticAssertionForm', problem: 'bindValueFirst'})
  }
  const site = addSite(context, annotation.call)
  if (annotation.role === 'requirement') {
    return addInstructionAtSite(context, site, {kind: 'staticRequire', value})
  }
  const assertion = context.assertions.length
  context.assertions.push({site, text: condition.getText(context.sourceFile)})
  return addInstructionAtSite(context, site, {kind: 'staticAssert', value, assertion})
}

type WrittenRequirementOperand = {kind: 'parameter'; value: ValueID} | {kind: 'constant'; value: number}

type WrittenRequirement =
  | {kind: 'numberCheck'; predicate: 'integer' | 'finite'; value: ValueID}
  | {
      kind: 'comparison'
      left: WrittenRequirementOperand
      right: WrittenRequirementOperand
      operator: ComparisonOperator
    }

function writtenRequirement(condition: ts.Expression, context: FunctionContext): WrittenRequirement | null {
  const current = unwrapParentheses(condition)
  if (ts.isCallExpression(current) && current.questionDotToken == null
    && current.arguments.length === 1 && ts.isPropertyAccessExpression(current.expression)
    && current.expression.questionDotToken == null
    && isStandardGlobal(current.expression.expression, 'Number', context)
    && (current.expression.name.text === 'isInteger' || current.expression.name.text === 'isFinite')) {
    const argument = current.arguments[0]!
    const value = staticRequirementParameterPathValue(argument, context)
    return value == null ? null : {
      kind: 'numberCheck',
      predicate: current.expression.name.text === 'isInteger' ? 'integer' : 'finite',
      value,
    }
  }
  if (!ts.isBinaryExpression(current) || !staticAssertionComparison(current.operatorToken.kind)) return null
  const leftParameter = staticRequirementParameterPathValue(current.left, context)
  const rightParameter = staticRequirementParameterPathValue(current.right, context)
  const leftConstant = leftParameter == null ? staticFiniteValue(current.left, context) : null
  const rightConstant = rightParameter == null ? staticFiniteValue(current.right, context) : null
  const left = leftParameter != null
    ? {kind: 'parameter' as const, value: leftParameter}
    : leftConstant != null ? {kind: 'constant' as const, value: leftConstant} : null
  const right = rightParameter != null
    ? {kind: 'parameter' as const, value: rightParameter}
    : rightConstant != null ? {kind: 'constant' as const, value: rightConstant} : null
  const operator = comparisonOperator(current.operatorToken.kind)
  if (left == null || right == null || operator == null
    || (leftParameter != null && rightParameter != null)) return null
  return {kind: 'comparison', left, right, operator}
}

function staticRequirementParameterPathValue(expression: ts.Expression, context: FunctionContext): ValueID | null {
  requireNumberType(expression, context.checker)
  let root = unwrapParentheses(expression)
  while (ts.isPropertyAccessExpression(root) && root.questionDotToken == null) {
    root = unwrapParentheses(root.expression)
  }
  if (!ts.isIdentifier(root)) return null
  const symbol = context.checker.getSymbolAtLocation(root)
  const rootValue = symbol == null ? null : context.bindings.get(symbol)
  if (rootValue == null || !valueComesFromParameter(rootValue, context)) return null
  return lowerExpression(expression, context)
}

function valueComesFromParameter(value: ValueID, context: FunctionContext): boolean {
  if (context.parameters.some(parameter => parameter.value === value)) return true
  for (const block of context.blocks) {
    const producer = block.instructions.find(instruction => instruction.result === value)
    if (producer != null) {
      return producer.kind === 'property' && valueComesFromParameter(producer.object, context)
    }
  }
  return false
}

function staticFiniteValue(
  expression: ts.Expression,
  context: FunctionContext,
): number | null {
  const seen = new Set<ts.Symbol>()
  let current = expression
  while (true) {
    const literal = numericLiteralValue(current)
    if (literal != null) return Number.isFinite(literal) ? literal : null
    const unwrapped = unwrapParentheses(current)
    if (!ts.isIdentifier(unwrapped)) return null
    const symbol = resolvedSymbol(context.checker.getSymbolAtLocation(unwrapped), context.checker)
    if (symbol == null || seen.has(symbol)) return null
    seen.add(symbol)
    const declaration = symbol.valueDeclaration
    if (declaration == null || !ts.isVariableDeclaration(declaration)
      || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0
      || declaration.getSourceFile().isDeclarationFile
      || declaration.initializer == null) return null
    current = declaration.initializer
  }
}

function lowerWrittenRequirement(
  requirement: WrittenRequirement,
  condition: ts.Expression,
  context: FunctionContext,
): ValueID {
  if (requirement.kind === 'numberCheck') {
    return addInstruction(context, condition, {
      kind: 'numberCheck',
      predicate: requirement.predicate,
      value: requirement.value,
    })
  }
  const lowerOperand = (operand: WrittenRequirementOperand): ValueID => {
    if (operand.kind === 'parameter') return operand.value
    return addInstruction(context, condition, {kind: 'constant', value: operand.value})
  }
  return addInstruction(context, condition, {
    kind: 'compare',
    operator: requirement.operator,
    left: lowerOperand(requirement.left),
    right: lowerOperand(requirement.right),
  })
}

// The static assertion language is deliberately smaller than ordinary expressions. A
// calculation is written and checked as normal code, then the assertion names its result.
// This gives agents one syntax boundary instead of exposing whichever instructions happen
// to be removable after general expression lowering.
function supportedWrittenAssertion(condition: ts.Expression, context: FunctionContext): boolean {
  const current = unwrapParentheses(condition)
  if (ts.isBinaryExpression(current) && staticAssertionComparison(current.operatorToken.kind)) {
    return staticAssertionNumericAtom(current.left, context.checker)
      && staticAssertionNumericAtom(current.right, context.checker)
  }
  const operand = staticNumberCheckOperand(current, context)
  return operand != null && staticAssertionNumericAtom(operand, context.checker)
}

function staticAssertionNumericAtom(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  return staticAssertionAtom(expression) && valueKind(checker.getTypeAtLocation(expression), checker) === 'number'
}

function staticAssertionComparison(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.LessThanToken:
    case ts.SyntaxKind.LessThanEqualsToken:
    case ts.SyntaxKind.GreaterThanToken:
    case ts.SyntaxKind.GreaterThanEqualsToken:
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsEqualsToken: return true
    default: return false
  }
}

function staticAssertionAtomProblem(expression: ts.Expression): StaticAssertionProblem | null {
  const current = unwrapParentheses(expression)
  if (ts.isIdentifier(current) || ts.isNumericLiteral(current)) return null
  if (ts.isPrefixUnaryExpression(current)
    && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)) {
    return ts.isNumericLiteral(unwrapParentheses(current.operand)) ? null : 'bindValueFirst'
  }
  if (ts.isElementAccessExpression(current)) return 'bindValueFirst'
  if (ts.isNonNullExpression(current)) return staticAssertionAtomProblem(current.expression)
  if (ts.isCallExpression(current)) return 'functionCall'
  if (ts.isBinaryExpression(current)) return 'bindValueFirst'
  if (ts.isPropertyAccessExpression(current)) {
    return current.questionDotToken == null
      ? staticAssertionAtomProblem(current.expression)
      : 'directCheck'
  }
  return 'directCheck'
}

function staticAssertionAtom(expression: ts.Expression): boolean {
  const current = unwrapParentheses(expression)
  if (ts.isIdentifier(current) || ts.isNumericLiteral(current)) return true
  if (ts.isPrefixUnaryExpression(current)
    && (current.operator === ts.SyntaxKind.PlusToken || current.operator === ts.SyntaxKind.MinusToken)) {
    return ts.isNumericLiteral(unwrapParentheses(current.operand))
  }
  return ts.isPropertyAccessExpression(current)
    && current.questionDotToken == null
    && staticAssertionAtom(current.expression)
}

function staticAssertionProblem(
  condition: ts.Expression,
  context: FunctionContext,
  fallback: 'directCheck' | 'callerRequirement',
): StaticAssertionProblem {
  const current = unwrapParentheses(condition)
  if (ts.isBinaryExpression(current) && staticAssertionComparison(current.operatorToken.kind)) {
    return staticAssertionAtomProblem(current.left) ?? staticAssertionAtomProblem(current.right) ?? fallback
  }
  const operand = staticNumberCheckOperand(current, context)
  if (operand != null) return staticAssertionAtomProblem(operand) ?? fallback
  if (ts.isCallExpression(current)) return 'functionCall'
  return 'directCheck'
}

function staticNumberCheckOperand(expression: ts.Expression, context: FunctionContext): ts.Expression | null {
  if (!ts.isCallExpression(expression) || expression.questionDotToken != null
    || expression.arguments.length !== 1 || !ts.isPropertyAccessExpression(expression.expression)
    || expression.expression.questionDotToken != null) return null
  const callee = expression.expression
  return isStandardGlobal(callee.expression, 'Number', context)
    && (callee.name.text === 'isInteger' || callee.name.text === 'isFinite' || callee.name.text === 'isNaN')
    ? expression.arguments[0]!
    : null
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  let current = expression
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

// An application may erase static conditions from a production build. Normal expression
// lowering owns their JavaScript evaluation order; this list only accepts instructions
// whose removal cannot change program state. Compound control flow was rejected above.
function removableStaticConditionInstruction(instruction: InstructionIR): boolean {
  switch (instruction.kind) {
    case 'constant':
    case 'arrayLength':
    case 'moduleRead':
    case 'compare':
    case 'platformValue':
    case 'numberCheck':
    case 'property': return true
    default: return false
  }
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

// The shared value-producing branch shape: lower each arm in its own block, then join at
// a continuation whose single parameter carries the result. Arms are assignment-free, so
// the join needs no binding merge. One entry accepts an existing condition value; the other
// keeps a compound condition split into branches so each check can narrow later operands.
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
  return joinValueBranches(
    node,
    whenTrue,
    whenFalse,
    lowerTrueArm,
    lowerFalseArm,
    context,
  )
}

function lowerBranchingValue(
  node: ts.Expression,
  condition: ts.Expression,
  lowerTrueArm: () => ValueID,
  lowerFalseArm: () => ValueID,
  context: FunctionContext,
): ValueID {
  const whenTrue = createBlock(context)
  const whenFalse = createBlock(context)
  lowerBranchingCondition(condition, whenTrue, whenFalse, context)
  return joinValueBranches(
    node,
    whenTrue,
    whenFalse,
    lowerTrueArm,
    lowerFalseArm,
    context,
  )
}

function joinValueBranches(
  node: ts.Expression,
  whenTrue: number,
  whenFalse: number,
  lowerTrueArm: () => ValueID,
  lowerFalseArm: () => ValueID,
  context: FunctionContext,
): ValueID {
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
  // Through the same short-circuit branching statement ifs use, so an `&&`-joined
  // condition refines each conjunct in the arms — `a > 0 && b > 0 ? a / b : 0`
  // discharges b's nonzero exactly like the if-statement spelling does. Lowering the
  // condition as one boolean expression (the previous shape) hid the conjuncts behind a
  // joined block parameter no branch refinement could see through; a conversion pass on
  // the owner's repo caught the asymmetry.
  return lowerBranchingValue(
    expression,
    expression.condition,
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
  return lowerBranchingValue(
    expression,
    expression.left,
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
  // TypeScript permits `any` in a numeric operation, but its static permission proves
  // nothing about the runtime value. Let the claim-free value reach the evaluator, whose
  // numeric gate stops only the path that executes the operation. Other non-number types
  // remain lowering rejections because diagnostic-clean TypeScript does not license them.
  if (valueKind(type, checker) !== 'number' && (type.flags & ts.TypeFlags.Any) === 0) {
    throw unsupported(node, {kind: 'nonNumberOperand', typeText: checker.typeToString(type)})
  }
}

function typeCanIncludeUndefined(type: ts.Type): boolean {
  if ((type.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return true
  return type.isUnion() && type.types.some(typeCanIncludeUndefined)
}

function lowerParameterDefault(
  default_: ParameterDefaultLiteral,
  node: ts.Expression,
  context: FunctionContext,
): ValueID {
  switch (default_.kind) {
    case 'number': return addInstruction(context, node, {kind: 'constant', value: default_.value})
    case 'boolean': return addInstruction(context, node, {kind: 'booleanConstant', value: default_.value})
    case 'opaque': return addInstruction(context, node, {kind: 'opaqueConstant', content: default_.content})
    case 'nullish': return addInstruction(context, node, {kind: 'nullishConstant', sentinel: default_.sentinel})
  }
}

// The single value kind a type describes, or null when the type mixes kinds (a union like
// number | boolean), mixes object shapes without a supported tag (a union like {x} |
// {x, y}), or falls outside the accepted kinds entirely (e.g. bigint or symbol).
type ValueKindResult = 'number' | 'boolean' | 'object' | 'nullable' | 'array' | 'tuple' | 'opaque' | 'taggedUnion' | null

// Exact memoization keyed on (interned type, remaining depth budget): the walk is pure
// over both, so the cache cannot change any answer — it only stops the same type being
// re-walked from every expression node that mentions it. A profiling pass measured one
// context-bag file issuing 757 million checker queries over ~216 distinct types, ~93% of
// the whole survey's wall time, precisely because these walks recompute per call site.
// (declaredKind has had the same cache since the tagged-union milestone; valueKind and
// taggedUnionProperty gain theirs here.)
const valueKindCache = new WeakMap<ts.Type, ValueKindResult[]>()

export function valueKind(type: ts.Type, checker: ts.TypeChecker, depth = 0): ValueKindResult {
  // The depth guard bounds recursion into element types (a recursive `type T = T[]` would
  // otherwise loop); past it, nothing classifies.
  if (depth > 8) return null
  let byDepth = valueKindCache.get(type)
  if (byDepth == null) {
    byDepth = []
    valueKindCache.set(type, byDepth)
  }
  const cached = byDepth[depth]
  if (cached !== undefined) return cached
  const result = valueKindUncached(type, checker, depth)
  byDepth[depth] = result
  return result
}

function valueKindUncached(type: ts.Type, checker: ts.TypeChecker, depth: number): ValueKindResult {
  if (numberConstituent(type) != null) return 'number'
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
  // `unknown` and `any` both carry without claims. For unknown the checker forces
  // narrowing before any use, so its word stays intact; for any the checker's word is
  // void, and claim-free is the one honest reading — nothing numeric is ever said about
  // the value, operations that require a concrete kind stop at their gates, and a write
  // into a typed binding leaves the binding opaque instead of re-minting claims.
  if ((type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0) return 'opaque'
  if (type.isUnion()) {
    // `T | null`, `T | undefined`, and `T | null | undefined` classify as nullable when T
    // itself classifies to one kind. Gates that cannot carry a missing value keep
    // rejecting ('nullable' matches neither 'number' nor 'object'); kind-agnostic gates
    // (declarators, ternary results, destructure elements, returns) accept.
    const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    if (type.types.some(member => (member.flags & missingFlags) !== 0)) {
      const rest = nonMissingUnionMembers(type)
      // The non-missing rest classifies as a group, so `4 | 8 | 24 | undefined` — an
      // as-const table's bare dynamic read — is nullable like `number | undefined`. A
      // rest that is itself a tagged union (`null | LightboxOwnerRoute`) is nullable too.
      const restKind = classifyUnionMembers(rest, checker, depth + 1)
      if (restKind != null) return 'nullable'
      return taggedUnionProperty(rest, checker, depth) == null ? null : 'nullable'
    }
    // A shared string- or boolean-literal property makes a record union tagged. Other
    // structural unions reject; scalar literal unions still collapse to one shared kind.
    if (taggedUnionProperty(type.types, checker, depth) != null) return 'taggedUnion'
    return classifyUnionMembers(type.types, checker, depth + 1)
  }
  return null
}

// Filtering a nullable union creates a new array. That array is also the exact cache key
// for taggedUnionProperty, so rebuilding it during every recursive declared-kind walk
// defeats that cache. TypeScript interns union types, which makes their filtered member
// lists safe to reuse as well.
const nonMissingUnionMembersCache = new WeakMap<ts.UnionType, readonly ts.Type[]>()

export function nonMissingUnionMembers(type: ts.UnionType): readonly ts.Type[] {
  const cached = nonMissingUnionMembersCache.get(type)
  if (cached != null) return cached
  const missingFlags = ts.TypeFlags.Null | ts.TypeFlags.Undefined
  const members = type.types.filter(member => (member.flags & missingFlags) === 0)
  nonMissingUnionMembersCache.set(type, members)
  return members
}

// The property that tells a union of record shapes apart: present and required in every
// member, typed as a single string literal in each. The first property (in the first
// member's declaration order) that qualifies wins — by convention the tag comes first
// (`type: 'lightbox'`). Two members MAY share a tag value (`{type: 'updates'; tab} |
// {type: 'updates'; article}`): a tag check then keeps both. Code that must tell them apart
// needs a distinct tag value; `in` checks are outside the subset because width subtyping
// permits undeclared extra properties. Null when no property qualifies.
// Keyed on the members ARRAY: a union type's .types array is interned by the checker, so
// the reference identifies the member set exactly. Nullable unions use the stable array
// from nonMissingUnionMembers; any other freshly built array simply misses.
const taggedUnionPropertyCache = new WeakMap<readonly ts.Type[], Array<string | null>>()

export function taggedUnionProperty(members: readonly ts.Type[], checker: ts.TypeChecker, depth = 0): string | null {
  if (members.length < 2) return null
  let byDepth = taggedUnionPropertyCache.get(members)
  if (byDepth == null) {
    byDepth = []
    taggedUnionPropertyCache.set(members, byDepth)
  }
  const cached = byDepth[depth]
  if (cached !== undefined) return cached
  const result = taggedUnionPropertyUncached(members, checker, depth)
  byDepth[depth] = result
  return result
}

function taggedUnionPropertyUncached(members: readonly ts.Type[], checker: ts.TypeChecker, depth: number): string | null {
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

// The callee as a short display name for the call rejection. A method on a simple
// receiver reads naturally (localStorage.getItem, Math.max — one or two identifiers); a
// method on a computed receiver — a call result, a regex literal, a chained pipeline —
// collapses to (…).method. Raw source text carried newlines into the report (breaking
// the one-fact-per-line format) and made the survey tally fragment into one bucket per
// call site; the collapsed form keeps lines whole and groups the tally by method.
function calleeDisplayName(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  if (ts.isPropertyAccessExpression(expression)) {
    const receiver = expression.expression
    const receiverName = ts.isIdentifier(receiver)
      ? receiver.text
      : ts.isPropertyAccessExpression(receiver) && ts.isIdentifier(receiver.expression)
        ? `${receiver.expression.text}.${receiver.name.text}`
        : '(…)'
    return `${receiverName}.${expression.name.text}`
  }
  return expression.getText(sourceFile).replace(/\s+/g, ' ').slice(0, 60)
}

// The literal written in an object literal's tag position, or null: a string literal, a
// no-substitution template, or the true/false keywords, seen through parens, satisfies,
// and as-const (unwrap peels exactly those). Quoted property names count — the rule is
// about the VALUE being a written literal, not about how the key is spelled.
function writtenTagLiteral(
  literal: ts.Expression,
  tagProperty: string,
  context: FunctionContext,
): string | boolean | null {
  if (!ts.isObjectLiteralExpression(literal)) return null
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : null
    if (name !== tagProperty) continue
    const initializer = unwrap(property.initializer, context.checker)
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return initializer.text
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) return true
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) return false
    return null
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

// One shared kind for a group of scalar union members, or null. Multiple object, array,
// or tuple members need a string or boolean tag and are handled before this function.
// A one-member list can occur after removing null and undefined; retain the ordinary
// depth and cycle check for that structural member without comparing it to another shape.
function classifyUnionMembers(
  members: readonly ts.Type[],
  checker: ts.TypeChecker,
  depth: number,
): 'number' | 'boolean' | 'object' | 'array' | 'tuple' | 'opaque' | null {
  if (depth > 8) return null
  let shared: 'number' | 'boolean' | 'object' | 'array' | 'tuple' | 'opaque' | null = null
  for (const member of members) {
    const kind = valueKind(member, checker, depth)
    // A nullable or tagged-union member cannot arise here (TypeScript flattens nested
    // unions), but the type system cannot see that; both fail the shared-kind rule.
    if (kind == null || kind === 'nullable' || kind === 'taggedUnion' || (shared != null && kind !== shared)) return null
    if (kind === 'object' || kind === 'array' || kind === 'tuple') {
      if (members.length > 1 || !structuralTypeWalkCompletes(member, checker, [])) return null
    }
    shared = kind
  }
  return shared
}

// Nullable records still need the same bounded walk as other declared structures. A
// recursive or excessively deep member rejects instead of producing an enormous partial
// record. This walk only checks that traversal completes; it does not compare shapes.
function structuralTypeWalkCompletes(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): boolean {
  if (type.isIntersection() && valueKind(type, checker) === 'object') {
    if (seen.length >= 8 || seen.includes(type)) return false
    return structuralPropertiesComplete(type, checker, seen)
  }
  if (type.isUnion()) return type.types.every(member => structuralTypeWalkCompletes(member, checker, seen))
  if (checker.isTupleType(type)) {
    if (seen.length >= 8 || seen.includes(type)) return false
    return checker.getTypeArguments(type as ts.TypeReference)
      .every(member => structuralTypeWalkCompletes(member, checker, [...seen, type]))
  }
  if (checker.isArrayType(type)) {
    if (seen.length >= 8 || seen.includes(type)) return false
    const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number)
    return element == null || structuralTypeWalkCompletes(element, checker, [...seen, type])
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return true
  if (seen.length >= 8 || seen.includes(type)) return false
  if (declaredOnlyInDeclarationFiles(type.getSymbol() ?? type.aliasSymbol)) return true
  if (checker.getIndexInfosOfType(type).length > 0) return true
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) return true
  return structuralPropertiesComplete(type, checker, seen)
}

function structuralPropertiesComplete(type: ts.Type, checker: ts.TypeChecker, seen: ts.Type[]): boolean {
  const nextSeen = [...seen, type]
  for (const property of checker.getPropertiesOfType(type)) {
    if ((property.flags & ts.SymbolFlags.Optional) !== 0) continue
    if (!structuralTypeWalkCompletes(checker.getTypeOfSymbol(property), checker, nextSeen)) return false
  }
  return true
}

// Truthiness conditions like `if (width)` on a number are legal TypeScript but outside the
// accepted subset; the engine represents conditions as booleans only.
export function requireBooleanCondition(node: ts.Node, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(node)
  const kind = valueKind(type, checker)
  if (kind === 'boolean') return
  throw unsupported(node, {
    kind: 'nonBooleanCondition',
    conditionKind: kind === 'number' ? 'number' : 'other',
    typeText: checker.typeToString(type),
  })
}

function requireAccessedPropertyKind(access: ts.PropertyAccessExpression, checker: ts.TypeChecker): void {
  const type = checker.getTypeAtLocation(access)
  if (valueKind(type, checker) != null) return
  throw unsupported(access, {kind: 'valueType', typeText: checker.typeToString(type)})
}

function resolvedSymbol(symbol: ts.Symbol | undefined, checker: ts.TypeChecker): ts.Symbol | null {
  if (symbol == null) return null
  return (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol)
}

function isStandardGlobal(expression: ts.Expression, name: string, context: FunctionContext): boolean {
  if (!ts.isIdentifier(expression) || expression.text !== name) return false
  return hasDefaultLibraryDeclaration(
    context.checker.getSymbolAtLocation(expression),
    context.program,
  )
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
  const missingFlag = ts.TypeFlags.Undefined
  const staticTypeAllowsUndefined = (resultType.flags & missingFlag) !== 0
    || (resultType.isUnion() && resultType.types.some(member => (member.flags & missingFlag) !== 0))
  return addInstruction(context, access, {
    kind: 'arrayIndex',
    array,
    index,
    mode: asserted ? 'asserted' : staticTypeAllowsUndefined ? 'bare' : 'bareUnchecked',
  })
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
  // narrowing spelling for number | undefined and friends.
  const primitiveTypeofFlags = (side: ts.Expression): ts.TypeFlags | null => {
    const unwrapped = unwrap(side, context.checker)
    if (!ts.isStringLiteral(unwrapped)) return null
    switch (unwrapped.text) {
      case 'number': return ts.TypeFlags.NumberLike
      case 'string': return ts.TypeFlags.StringLike
      case 'boolean': return ts.TypeFlags.BooleanLike
      default: return null
    }
  }
  const rightFlags = primitiveTypeofFlags(expression.right)
  const leftFlags = primitiveTypeofFlags(expression.left)
  const typeofSide = ts.isTypeOfExpression(expression.left) && rightFlags != null
    ? {operand: expression.left, flags: rightFlags}
    : ts.isTypeOfExpression(expression.right) && leftFlags != null
      ? {operand: expression.right, flags: leftFlags}
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
    const missing = ts.TypeFlags.Null | ts.TypeFlags.Undefined
    const members = operandType.isUnion() ? operandType.types : [operandType]
    const restMatches = members.every(member =>
      (member.flags & missing) !== 0
      || (typeofSide.flags === ts.TypeFlags.NumberLike
        ? valueKind(member, context.checker) === 'number'
        : (member.flags & typeofSide.flags) !== 0))
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

// Resolves an identifier read: a function-local binding first, then a module binding
// (which reads the binding's slot), then the global `Infinity` as an exact constant,
// else the identifier is unknown. A local or module binding named Infinity has a
// different symbol and wins above; only TypeScript's standard Infinity receives the
// exact constant.
function identifierValue(symbol: ts.Symbol, node: ts.Identifier, context: FunctionContext): ValueID {
  const local = context.bindings.get(symbol)
  if (local != null) return local
  const binding = context.moduleBindingsBySymbol.get(symbol)
  if (binding != null) return addInstruction(context, node, {kind: 'moduleRead', binding})
  if (isStandardGlobal(node, 'Infinity', context)) {
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
    // Only `as const` peels: TypeScript permits it solely on literals and it narrows the
    // literal to its own literal type, so the value kind provably cannot change. Every
    // other as/angle assertion is an erasure point (see the as/angle arm in
    // lowerExpression) — an assertion is exactly where the checker's word and the runtime
    // value may diverge, and claim-free is the one honest reading. Three review rounds
    // settled this: each attempt to LICENSE carrying (asserted kind matches operand kind;
    // then recursive type-shape comparisons) was defeated by another diagnostic-clean aliasing
    // route (`true as {} as number` via comparability, `flags as unknown[] as number[]`
    // at the element level, optional-property and heterogeneous-union comparison
    // collisions). No type-level test can be finer than TypeScript's own cast
    // permissiveness, so the license is gone rather than repaired again.
    if ((ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
      && ts.isConstTypeReference(current.type)) {
      current = current.expression
      continue
    }
    // The non-null assertion `x!` peels only while the value kind is unchanged underneath —
    // on a nullable type, e.g. `x!` with `x: number | null`, the static type stops
    // describing the value the analysis models, so stop. The one blessed kind-changing
    // form is `arr[i]!`: the syntax itself requests asserted-read treatment — an in-bounds
    // assumption line, or a bounds proof when the loop supplies one. Bare reads carry
    // possible undefined in the engine regardless of the project's TypeScript options.
    if (ts.isNonNullExpression(current)) {
      const assertedType = checker.getTypeAtLocation(current)
      const operandType = checker.getTypeAtLocation(current.expression)
      // The one blessed kind-changing assertion is `arr[i]!`: the asserted read gets its
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
