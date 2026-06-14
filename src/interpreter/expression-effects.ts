import * as ts from 'typescript'
import type {Program} from '../check-types.ts'
import {functionImplementationReference, isInlineFunction} from '../function-shape.ts'
import {
  defaultLibraryOwner,
  elementAccessHasSourceAccessor,
  isDefaultLibraryMemberAccess,
  isDefaultLibrarySymbol,
  propertyAccessHasSourceAccessor,
  resolveCallTarget,
} from './call-targets.ts'
import {functionPurity} from './function-effects.ts'
import {platformGlobalEffect, platformMethodEffect} from './platform-effects.ts'
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
    const resolved = resolveCallTarget(current, program)
    return resolved.kind === 'function'
      && functionPurity(functionImplementationReference(resolved.program, resolved.fn.node)).kind === 'pure'
  }
  if (ts.isElementAccessExpression(current)) {
    if (elementAccessHasSourceAccessor(current, 'get', program)) return false
    return expressionIsRepeatable(current.expression, program)
      && (current.argumentExpression == null || expressionIsRepeatable(current.argumentExpression, program))
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
    const effect = platformGlobalEffect(target.expression.text, target.name.text, call.arguments.length)
    return effect != null && platformEffectIsRepeatable(call, effect, program)
  }

  if (ts.isPropertyAccessExpression(target) && isDefaultLibraryMemberAccess(target, program)) {
    if (!expressionIsRepeatable(target.expression, program)) return false
    const effect = platformMethodEffect(
      defaultLibraryOwner(target, program),
      target.name.text,
      call.arguments.length,
    )
    return effect != null && platformEffectIsRepeatable(call, effect, program)
  }

  const resolved = resolveCallTarget(target, program)
  if (resolved.kind === 'math') return resolved.name !== 'random'
  if (resolved.kind !== 'function') return false
  return functionPurity(functionImplementationReference(resolved.program, resolved.fn.node)).kind === 'pure'
}

function platformEffectIsRepeatable(
  call: ts.CallExpression,
  effect: NonNullable<ReturnType<typeof platformMethodEffect>>,
  program: Program,
): boolean {
  if (effect.mutatesReceiver || effect.mutatesArgumentIndexes.length > 0 || effect.observesEnvironment) return false
  for (const callback of effect.callbacks) {
    const argument = call.arguments[callback.argumentIndex]
    if (argument == null || ts.isSpreadElement(argument)) return false
    const current = unwrapExpression(argument)
    const implementation = isInlineFunction(current)
      ? functionImplementationReference(program, current)
      : resolvedFunctionReference(current, program)
    if (implementation == null || functionPurity(implementation).kind !== 'pure') return false
  }
  return true
}

function resolvedFunctionReference(
  expression: ts.Expression,
  program: Program,
): ReturnType<typeof functionImplementationReference> | null {
  const resolved = resolveCallTarget(expression, program)
  return resolved.kind === 'function'
    ? functionImplementationReference(resolved.program, resolved.fn.node)
    : null
}
