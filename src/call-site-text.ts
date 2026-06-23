import * as ts from 'typescript'
import {type FitFunction} from './modules.ts'
import {parseExpression, replaceFitIdentifiers} from './parser.ts'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from './binding-patterns.ts'
import {
  linearNameForExpression,
  type ArraySummary,
  type Assumption,
  type NumberComputation,
  type NumberValue,
  type Value,
} from './domain.ts'
import type {PreparedCallSite} from './prepared-call.ts'
import {formatNumber} from './reporting.ts'
import {mapSequenceAddition} from './sequence-relation.ts'
import {
  linearFromTerms,
  linearFromExpressionText,
  linearVariable,
  type LinearExpr,
} from './linear.ts'
import {rationalAdd, rationalMultiply} from './numeric/rational.ts'

type MutableCallSiteBindings = Map<string, string>

export type CallSiteBindings = ReadonlyMap<string, string>

export function valueWithCallSiteText(value: Value, bindings: CallSiteBindings | undefined): Value {
  if (bindings == null || bindings.size === 0) return value
  if (value.kind === 'number') return numberWithCallSiteText(value, bindings)
  if (value.kind === 'literal') return {...value, expr: maybeCallSiteText(value.expr, bindings)}
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, valueWithCallSiteText(prop, bindings))
    return {...value, props, expr: maybeCallSiteText(value.expr, bindings)}
  }
  if (value.kind === 'array') {
    const expr = maybeCallSiteText(value.expr, bindings)
    return value.layout === 'tuple'
      ? {...value, elements: value.elements.map(element => valueWithCallSiteText(element, bindings)), expr}
      : {
          ...value,
          length: numberWithCallSiteText(value.length, bindings),
          element: value.element == null ? null : valueWithCallSiteText(value.element, bindings),
          expr,
          summary: arraySummaryWithCallSiteText(value.summary, bindings),
        }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithCallSiteText(value.present, bindings), expr: maybeCallSiteText(value.expr, bindings)}
  }
  if (value.kind === 'null') return {...value, expr: maybeCallSiteText(value.expr, bindings)}
  return value
}

export function callSiteBindingsFor(
  fn: FitFunction,
  callSite: PreparedCallSite,
  thisText?: string,
): CallSiteBindings {
  const bindings: MutableCallSiteBindings = new Map()
  if (thisText != null) bindings.set('this', callSiteValueText(thisText))
  for (let i = 0; i < fn.node.parameters.length; i++) {
    const source = callSite.parameterSources[i]
    if (source == null) continue
    const rebasedSourceText = source.scope === 'callee'
      ? callSiteTextWhileBuilding(source.text, bindings)
      : source.text
    bindCallSitePattern(
      fn.node.parameters[i]!.name,
      rebasedSourceText,
      callSite.boundValues,
      bindings,
      source.scope === 'callee',
    )
  }
  return new Map(bindings)
}

export function callSiteText(text: string, bindings: CallSiteBindings | undefined) {
  if (bindings == null || bindings.size === 0) return text
  return replaceFitIdentifiers(text, bindings)
}

function callSiteTextWhileBuilding(text: string, bindings: MutableCallSiteBindings) {
  return replaceFitIdentifiers(text, bindings)
}

function numberWithCallSiteText(value: NumberValue, bindings: CallSiteBindings): NumberValue {
  return {
    ...value,
    expr: maybeCallSiteText(value.expr, bindings),
    linear: linearWithCallSiteText(value.linear, bindings),
    computation: computationWithCallSiteText(value.computation, bindings),
    cases: value.cases == null ? null : value.cases.map(choice => ({
      value: numberWithCallSiteText(choice.value, bindings),
      assumptions: choice.assumptions.map(assumption => constraintWithCallSiteText(assumption, bindings)),
      branches: choice.branches,
    })),
  }
}

function computationWithCallSiteText(
  computation: NumberComputation | null,
  bindings: CallSiteBindings,
): NumberComputation | null {
  if (computation == null) return null
  return computation.kind === 'unary'
    ? {...computation, operand: numberWithCallSiteText(computation.operand, bindings)}
    : {
        ...computation,
        left: numberWithCallSiteText(computation.left, bindings),
        right: numberWithCallSiteText(computation.right, bindings),
      }
}

function linearWithCallSiteText(
  linear: LinearExpr | null,
  bindings: CallSiteBindings,
): LinearExpr | null {
  if (linear == null) return null
  let constant = linear.constant
  const terms = new Map<string, LinearExpr['constant']>()
  for (const [name, coefficient] of linear.terms) {
    const text = callSiteText(name, bindings)
    const replacement = linearFromExpressionText(text)
      ?? linearVariable(linearNameForExpression(text))
    constant = rationalAdd(
      constant,
      rationalMultiply(coefficient, replacement.constant),
    )
    for (const [replacementName, replacementCoefficient] of replacement.terms) {
      const scaled = rationalMultiply(coefficient, replacementCoefficient)
      const previous = terms.get(replacementName)
      terms.set(
        replacementName,
        previous == null ? scaled : rationalAdd(previous, scaled),
      )
    }
  }
  return linearFromTerms(constant, terms)
}

function arraySummaryWithCallSiteText(summary: ArraySummary | null, bindings: CallSiteBindings): ArraySummary | null {
  if (summary == null) return null
  return {
    origin: summary.origin == null ? null : {...summary.origin, sourceExpr: callSiteText(summary.origin.sourceExpr, bindings)},
    relations: summary.relations.map(relation => relation.kind === 'adjacent-comparison'
      ? {
          ...relation,
          right: {...relation.right, addends: relation.right.addends.map(addend => callSiteText(addend, bindings))},
        }
      : {
          ...relation,
          right: mapSequenceAddition(relation.right, term => term, text => callSiteText(text, bindings))!,
        }),
    advances: summary.advances.map(fact => ({...fact, value: numberWithCallSiteText(fact.value, bindings)})),
    lastEnd: summary.lastEnd == null ? null : {...summary.lastEnd, value: numberWithCallSiteText(summary.lastEnd.value, bindings)},
    extentEnds: summary.extentEnds.map(fact => ({
      ...fact,
      emptyExpr: callSiteText(fact.emptyExpr, bindings),
      value: numberWithCallSiteText(fact.value, bindings),
    })),
  }
}

function constraintWithCallSiteText(assumption: Assumption, bindings: CallSiteBindings): Assumption {
  return {
    ...assumption,
    diff: linearWithCallSiteText(assumption.diff, bindings),
    ...(assumption.leftExpr == null ? {} : {leftExpr: callSiteText(assumption.leftExpr, bindings)}),
    ...(assumption.rightExpr == null ? {} : {rightExpr: callSiteText(assumption.rightExpr, bindings)}),
  }
}

function maybeCallSiteText(text: string | null, bindings: CallSiteBindings) {
  return text == null ? null : callSiteText(text, bindings)
}

function callSiteArgumentText(
  sourceText: string,
  value: Value,
  bindingName: string,
  bindings: MutableCallSiteBindings,
  rebaseValueText: boolean,
) {
  if (value.kind === 'number' && value.min === value.max) return formatNumber(value.min)
  if (value.kind === 'unknown' || value.expr == null || value.expr === bindingName) return sourceText
  return rebaseValueText ? callSiteTextWhileBuilding(value.expr, bindings) : value.expr
}

function bindCallSitePattern(
  name: ts.BindingName,
  sourceText: string,
  boundValues: ReadonlyMap<string, Value>,
  bindings: MutableCallSiteBindings,
  rebaseValueText: boolean,
) {
  if (ts.isIdentifier(name)) {
    const value = boundValues.get(name.text)
    const text = value == null
      ? sourceText
      : callSiteArgumentText(sourceText, value, name.text, bindings, rebaseValueText)
    bindings.set(name.text, callSiteValueText(text))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    const base = callSitePropertyBaseText(sourceText)
    for (const element of name.elements) {
      if (element.dotDotDotToken != null) continue
      const propertyName = bindingElementPropertyName(element)
      if (propertyName == null) continue
      bindCallSitePattern(element.name, `${base}.${propertyName}`, boundValues, bindings, rebaseValueText)
    }
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    const base = callSitePropertyBaseText(sourceText)
    forEachArrayBindingElement(name, (elementName, index, isRest) => {
      if (!isRest) bindCallSitePattern(elementName, `${base}[${index}]`, boundValues, bindings, rebaseValueText)
    })
  }
}

function callSiteValueText(text: string) {
  const trimmed = text.trim()
  return isSimpleCallSiteText(trimmed) || isParenthesizedCallSiteText(trimmed) ? trimmed : `(${trimmed})`
}

function callSitePropertyBaseText(text: string) {
  return callSiteValueText(text)
}

function isSimpleCallSiteText(text: string) {
  return /^(?:this|[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*|-?\d+(?:\.\d+)?)(?:(?:\.[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)|(?:\[[^\]]+\]))*$/u.test(text)
}

function isParenthesizedCallSiteText(text: string) {
  try {
    return ts.isParenthesizedExpression(parseExpression(text))
  } catch {
    return false
  }
}
