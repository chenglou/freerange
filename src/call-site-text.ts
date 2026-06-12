import * as ts from 'typescript'
import {type FitFunction} from './modules.ts'
import {parseExpression} from './parser.ts'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from './binding-patterns.ts'
import {
  type ArraySummary,
  type LinearConstraint,
  type NumberValue,
  type Value,
} from './domain.ts'

type MutableCallSiteBindings = Map<string, string>

export type CallSiteBindings = ReadonlyMap<string, string>

type CompiledCallSiteBindings = {
  pattern: RegExp
  replacements: Map<string, string>
}

const compiledBindingsCache = new WeakMap<CallSiteBindings, CompiledCallSiteBindings>()

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
  const bindings: MutableCallSiteBindings = new Map()
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
  const compiled = compiledCallSiteBindings(bindings)
  return text.replace(compiled.pattern, name => compiled.replacements.get(name) ?? name)
}

function compiledCallSiteBindings(bindings: CallSiteBindings): CompiledCallSiteBindings {
  const cached = compiledBindingsCache.get(bindings)
  if (cached != null) return cached
  const names = [...bindings.keys()].sort((left, right) => right.length - left.length)
  const compiled = {
    pattern: new RegExp(`(?<![\\p{ID_Continue}$.])(?:${names.map(escapeRegExp).join('|')})(?![\\p{ID_Continue}$]|\\s*\\()`, 'gu'),
    replacements: new Map(bindings),
  }
  compiledBindingsCache.set(bindings, compiled)
  return compiled
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
    advances: summary.advances.map(fact => ({...fact, value: numberWithCallSiteText(fact.value, bindings)})),
    lastEnd: summary.lastEnd == null ? null : {...summary.lastEnd, value: numberWithCallSiteText(summary.lastEnd.value, bindings)},
    extentEnds: summary.extentEnds.map(fact => ({
      ...fact,
      emptyExpr: callSiteText(fact.emptyExpr, bindings),
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

function bindCallSitePattern(name: ts.BindingName, sourceText: string, bindings: MutableCallSiteBindings) {
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
  return /^(?:this|[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*|-?\d+(?:\.\d+)?)(?:(?:\.[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*)|(?:\[[^\]]+\]))*$/u.test(text)
}

function isParenthesizedCallSiteText(text: string) {
  try {
    return ts.isParenthesizedExpression(parseExpression(text))
  } catch {
    return false
  }
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
