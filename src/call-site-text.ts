import * as ts from 'typescript'
import {type FitFunction} from './modules.ts'
import {parseExpression} from './parser.ts'
import {
  type ArraySummary,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'

export type CallSiteBindings = Map<string, string>

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
    return {
      ...value,
      length: numberWithCallSiteText(value.length, bindings),
      elements: value.elements == null ? null : value.elements.map(element => valueWithCallSiteText(element, bindings)),
      element: value.element == null ? null : valueWithCallSiteText(value.element, bindings),
      expr: maybeCallSiteText(value.expr, bindings),
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
  args: readonly ts.Expression[],
  sourceFile: ts.SourceFile,
  thisText?: string,
  argumentValues?: readonly Value[],
  argumentTexts?: readonly string[],
): CallSiteBindings {
  const bindings: CallSiteBindings = new Map()
  if (thisText != null) bindings.set('this', callSiteValueText(thisText))
  for (let i = 0; i < fn.node.parameters.length; i++) {
    const argument = args[i]
    const sourceText = argumentTexts?.[i] ?? (argument == null ? null : argument.getText(sourceFile))
    if (sourceText == null) continue
    bindCallSitePattern(fn.node.parameters[i]!.name, callSiteArgumentText(sourceText, argumentValues?.[i]), bindings)
  }
  return bindings
}

export function callSiteText(text: string, bindings: CallSiteBindings | undefined) {
  if (bindings == null || bindings.size === 0) return text
  let result = text
  for (const [name, replacement] of [...bindings].sort((left, right) => right[0].length - left[0].length)) {
    result = result.replace(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$]|\\s*\\()`, 'g'), () => replacement)
  }
  return result
}

function numberWithCallSiteText(value: NumberValue, bindings: CallSiteBindings): NumberValue {
  return {
    ...value,
    expr: maybeCallSiteText(value.expr, bindings),
    cases: value.cases == null ? null : value.cases.map(choice => ({
      value: numberWithCallSiteText(choice.value, bindings),
      assumptions: choice.assumptions.map(assumption => constraintWithCallSiteText(assumption, bindings)),
    })),
  }
}

function arraySummaryWithCallSiteText(summary: ArraySummary | null, bindings: CallSiteBindings): ArraySummary | null {
  if (summary == null) return null
  return {
    origin: summary.origin == null ? null : {...summary.origin, sourceExpr: callSiteText(summary.origin.sourceExpr, bindings)},
    relations: summary.relations.map(relation => ({
      ...relation,
      right: {...relation.right, addends: relation.right.addends.map(addend => callSiteText(addend, bindings))},
    })),
    nondecreasingProps: summary.nondecreasingProps,
    advances: summary.advances.map(fact => ({...fact, value: numberWithCallSiteText(fact.value, bindings)})),
    spaced: summary.spaced.map(fact => ({
      gapExpr: callSiteText(fact.gapExpr, bindings),
      heightExpr: callSiteText(fact.heightExpr, bindings),
      advanceExpr: callSiteText(fact.advanceExpr, bindings),
    })),
    lastEnd: summary.lastEnd == null ? null : numberWithCallSiteText(summary.lastEnd, bindings),
    extentEnds: summary.extentEnds.map(fact => ({
      emptyExpr: callSiteText(fact.emptyExpr, bindings),
      nonEmptyExpr: callSiteText(fact.nonEmptyExpr, bindings),
      value: numberWithCallSiteText(fact.value, bindings),
    })),
  }
}

function constraintWithCallSiteText(assumption: LinearConstraint, bindings: CallSiteBindings): LinearConstraint {
  return {
    ...assumption,
    ...(assumption.leftExpr == null ? {} : {leftExpr: callSiteText(assumption.leftExpr, bindings)}),
    ...(assumption.rightExpr == null ? {} : {rightExpr: callSiteText(assumption.rightExpr, bindings)}),
  }
}

function maybeCallSiteText(text: string | null, bindings: CallSiteBindings) {
  return text == null ? null : callSiteText(text, bindings)
}

function callSiteArgumentText(sourceText: string, value: Value | undefined) {
  return value?.kind === 'number' && value.expr != null ? value.expr : sourceText
}

function bindCallSitePattern(name: ts.BindingName, sourceText: string, bindings: CallSiteBindings) {
  if (ts.isIdentifier(name)) {
    bindings.set(name.text, callSiteValueText(sourceText))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    const base = callSitePropertyBaseText(sourceText)
    for (const element of name.elements) {
      if (element.dotDotDotToken != null) continue
      const propertyName = bindingElementPropertyName(element)
      if (propertyName == null) continue
      bindCallSitePattern(element.name, `${base}.${propertyName}`, bindings)
    }
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    const base = callSitePropertyBaseText(sourceText)
    forEachArrayBindingElement(name, (elementName, index, isRest) => {
      if (!isRest) bindCallSitePattern(elementName, `${base}[${index}]`, bindings)
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
  return /^(?:this|[A-Za-z_$][\w$]*|-?\d+(?:\.\d+)?)(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[[^\]]+\]))*$/.test(text)
}

function isParenthesizedCallSiteText(text: string) {
  try {
    return ts.isParenthesizedExpression(parseExpression(text))
  } catch {
    return false
  }
}

function forEachArrayBindingElement(
  pattern: ts.ArrayBindingPattern,
  visit: (name: ts.BindingName, index: number, isRest: boolean) => void,
) {
  pattern.elements.forEach((element, index) => {
    if (ts.isOmittedExpression(element)) return
    visit(element.name, index, element.dotDotDotToken != null)
  })
}

function bindingElementPropertyName(element: ts.BindingElement): string | null {
  if (element.propertyName == null) return ts.isIdentifier(element.name) ? element.name.text : null
  if (ts.isIdentifier(element.propertyName)) return element.propertyName.text
  if (ts.isStringLiteral(element.propertyName) || ts.isNumericLiteral(element.propertyName)) return element.propertyName.text
  return null
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
