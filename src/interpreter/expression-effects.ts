import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {isInlineFunction} from '../function-shape.ts'
import {
  callTargetImplementation,
  defaultLibraryOwner,
  elementAccessHasSourceAccessor,
  isDefaultLibraryMemberAccess,
  isDefaultLibrarySymbol,
  propertyAccessHasSourceAccessor,
  resolveCallTarget,
} from './call-targets.ts'
import {functionPurity} from './function-effects.ts'
import {callExpressionsForPosition} from './call-arguments.ts'
import {classifyPlatformGlobalCall, classifyPlatformMethodCall, type PlatformCallEffect} from './platform-effects.ts'
import {isAssignmentOperator, unwrapExpression} from './source-syntax.ts'

// True only when evaluating the expression again cannot mutate visible state,
// observe the environment, or call code whose behavior is unavailable. This is
// narrower than "the containing function is pure": branch refinement needs to
// know whether this particular source expression may be inspected again.
export function expressionIsRepeatable(expression: ts.Expression, program: Program): boolean {
  const current = unwrapExpression(expression)
  if (
    ts.isNumericLiteral(current)
    || ts.isStringLiteral(current)
    || ts.isNoSubstitutionTemplateLiteral(current)
    || ts.isIdentifier(current)
    || current.kind === ts.SyntaxKind.ThisKeyword
    || current.kind === ts.SyntaxKind.TrueKeyword
    || current.kind === ts.SyntaxKind.FalseKeyword
    || current.kind === ts.SyntaxKind.NullKeyword
  ) return true
  if (isInlineFunction(current)) return true
  if (ts.isTemplateExpression(current)) {
    return current.templateSpans.every(span => expressionIsRepeatable(span.expression, program))
  }
  if (ts.isPropertyAccessExpression(current)) {
    if (!expressionIsRepeatable(current.expression, program)) return false
    if (!propertyAccessHasSourceAccessor(current, 'get', program)) return true
    const implementation = callTargetImplementation(resolveCallTarget(current, program))
    return implementation != null && functionPurity(implementation).kind === 'pure'
  }
  if (ts.isElementAccessExpression(current)) {
    if (elementAccessHasSourceAccessor(current, 'get', program)) return false
    return expressionIsRepeatable(current.expression, program)
      && expressionIsRepeatable(current.argumentExpression, program)
  }
  if (ts.isPrefixUnaryExpression(current)) {
    return current.operator !== ts.SyntaxKind.PlusPlusToken
      && current.operator !== ts.SyntaxKind.MinusMinusToken
      && expressionIsRepeatable(current.operand, program)
  }
  if (ts.isPostfixUnaryExpression(current)) return false
  if (ts.isBinaryExpression(current)) {
    return !isAssignmentOperator(current.operatorToken.kind)
      && expressionIsRepeatable(current.left, program)
      && expressionIsRepeatable(current.right, program)
  }
  if (ts.isConditionalExpression(current)) {
    return expressionIsRepeatable(current.condition, program)
      && expressionIsRepeatable(current.whenTrue, program)
      && expressionIsRepeatable(current.whenFalse, program)
  }
  if (ts.isObjectLiteralExpression(current)) {
    return current.properties.every(property => {
      if (ts.isSpreadAssignment(property)) return expressionIsRepeatable(property.expression, program)
      if (ts.isShorthandPropertyAssignment(property)) return true
      return ts.isPropertyAssignment(property) && expressionIsRepeatable(property.initializer, program)
    })
  }
  if (ts.isArrayLiteralExpression(current)) {
    return current.elements.every(element => ts.isSpreadElement(element)
      ? expressionIsRepeatable(element.expression, program)
      : expressionIsRepeatable(element, program))
  }
  if (ts.isCallExpression(current)) return callIsRepeatable(current, program)
  if (ts.isVoidExpression(current) || ts.isTypeOfExpression(current)) {
    return expressionIsRepeatable(current.expression, program)
  }
  return false
}

function callIsRepeatable(call: ts.CallExpression, program: Program): boolean {
  const target = unwrapExpression(call.expression)
  if (!call.arguments.every(argument =>
    ts.isSpreadElement(argument)
      ? expressionIsRepeatable(argument.expression, program)
      : expressionIsRepeatable(argument, program))) return false

  if (
    ts.isPropertyAccessExpression(target)
    && ts.isIdentifier(target.expression)
    && isDefaultLibrarySymbol(target.expression, program)
    && isDefaultLibraryMemberAccess(target, program)
  ) {
    const classification = classifyPlatformGlobalCall(target.expression.text, target.name.text, call.arguments.length)
    return classification.kind === 'supported' && platformEffectIsRepeatable(call, classification.effect, program)
  }

  if (ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)) {
    if (!expressionIsRepeatable(target.expression, program)) return false
    const classification = classifyPlatformMethodCall(
      defaultLibraryOwner(target, program),
      target.name.text,
      call.arguments,
      program,
    )
    return classification.kind === 'supported' && platformEffectIsRepeatable(call, classification.effect, program)
  }

  const resolved = resolveCallTarget(target, program)
  if (resolved.kind === 'platform-global') {
    const classification = classifyPlatformGlobalCall(resolved.base, resolved.name, call.arguments.length)
    return classification.kind === 'supported'
      && platformEffectIsRepeatable(call, classification.effect, program)
  }
  const implementation = callTargetImplementation(resolved)
  return implementation != null && functionPurity(implementation).kind === 'pure'
}

function platformEffectIsRepeatable(
  call: ts.CallExpression,
  effect: PlatformCallEffect,
  program: Program,
): boolean {
  if (effect.mutatesReceiver || effect.mutatesArgumentIndexes.length > 0 || effect.observesEnvironment) return false
  for (const callback of effect.callbacks) {
    const mapped = callExpressionsForPosition(call.arguments, callback.argumentIndex)
    if (mapped.inexactSpread) return false
    const argument = mapped.expressions[0]
    if (argument == null) return false
    const implementation = callTargetImplementation(resolveCallTarget(unwrapExpression(argument), program))
    if (implementation == null || functionPurity(implementation).kind !== 'pure') return false
  }
  return true
}
