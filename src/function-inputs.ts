import * as ts from 'typescript'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from './binding-patterns.ts'
import {
  tupleElements,
  nullableValue,
  unknown,
  unknownArray,
  unknownNumber,
  unknownObject,
  type Value,
} from './domain.ts'
import {functionHasInstanceThisInput} from './function-shape.ts'
import {
  fitExpressionParsed,
  fitReturnInternalRoot,
  type FitExpressionLike,
  type FitSpec,
} from './parser.ts'
import {
  valueFromNodeShape,
  valueFromSyntaxTypeShape,
  valueWithStructuralFallback,
} from './shapes.ts'
import {
  expressionMentionsArrayParam,
  expressionMentionsObjectParam,
} from './source-expressions.ts'
import type {LocalizeOptions, Program} from './check-types.ts'
import type {FitFunction} from './modules.ts'
import {localizeValue} from './value-localize.ts'

export function bindFunctionInputParameters(fn: FitFunction, specs: FitSpec[], program: Program, env: Map<string, Value>) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', unknownParamValue('this', specs, undefined, program))
  }
  for (const param of fn.node.parameters) {
    if (ts.isIdentifier(param.name)) {
      env.set(param.name.text, unknownParamValue(param.name.text, specs, param.type, program, param))
      continue
    }
    bindPatternFromValue(param.name, unknownParamPatternValue(param, program), env)
  }
}

export function bindFunctionArgumentParameters(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, program: Program, options: LocalizeOptions = {}) {
  for (let i = 0; i < fn.node.parameters.length; i++) {
    const param = fn.node.parameters[i]!
    const value = argumentValues[i] ?? unknown(`Missing argument ${i} for ${fn.name}`)
    bindPatternFromValue(param.name, parameterArgumentValue(param, value, program), env, options)
  }
}

export function parameterArgumentValue(param: ts.ParameterDeclaration, value: Value, program: Program): Value {
  const expr = ts.isIdentifier(param.name) ? param.name.text : 'param'
  return valueWithStructuralFallback(value, valueFromSyntaxTypeShape(expr, param.type, program, new Set()))
}

export function bindFunctionCallInputs(fn: FitFunction, argumentValues: Value[], env: Map<string, Value>, program: Program, thisValue?: Value) {
  bindFunctionThisInput(fn, env, thisValue)
  bindFunctionArgumentParameters(fn, argumentValues, env, program, {preserveLinear: true})
}

export function bindFunctionThisInput(fn: FitFunction, env: Map<string, Value>, thisValue?: Value) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', localizeValue(thisValue ?? unknownObject('this'), 'this', {preserveLinear: true}))
  }
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, program: Program): Value {
  return valueFromNodeShape('param', param.name, program)
    ?? valueFromSyntaxTypeShape('param', param.type, program, new Set())
    ?? unknownObject('param')
}

export function bindPatternFromValue(name: ts.BindingName, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}) {
  if (ts.isIdentifier(name)) {
    env.set(name.text, localizeValue(value, name.text, options))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (element.dotDotDotToken != null) continue
      const propertyName = bindingElementPropertyName(element)
      if (propertyName == null) {
        bindUnknownPattern(element.name, env)
        continue
      }
      const prop = value.kind === 'object'
        ? value.props.get(propertyName) ?? unknownNumber(`${value.expr ?? 'param'}.${propertyName}`)
        : unknown(`Destructuring property ${propertyName} expected an object`)
      bindPatternFromValue(element.name, prop, env, options)
    }
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    bindArrayPatternFromValue(name, value, env, options)
    return
  }
  bindUnknownPattern(name, env)
}

function bindArrayPatternFromValue(name: ts.ArrayBindingPattern, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}) {
  forEachArrayBindingElement(name, (elementName, index, isRest) => {
    if (isRest) {
      bindUnknownPattern(elementName, env)
      return
    }
    const item = arrayPatternElementValue(value, index)
    bindPatternFromValue(elementName, item, env, options)
  })
}

function bindUnknownPattern(name: ts.BindingName, env: Map<string, Value>) {
  if (ts.isIdentifier(name)) {
    env.set(name.text, unknownNumber(name.text))
    return
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) bindUnknownPattern(element.name, env)
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    forEachArrayBindingElement(name, elementName => bindUnknownPattern(elementName, env))
  }
}

export function unknownParamValue(name: string, specs: FitSpec[], type: ts.TypeNode | undefined, program: Program, node?: ts.Node): Value {
  const typed = valueFromSyntaxTypeShape(name, type, program, new Set())
    ?? (type == null && node != null ? valueFromNodeShape(name, node, program) : null)
    ?? (type == null ? null : unknownObject(name))
  if (typed != null) return parameterOptionalValue(name, typed, node)

  const shape = specParamShape(name, specs)
  if (shape === 'array') return unknownArray(name)
  if (shape === 'object') return unknownObject(name)
  return unknownNumber(name)
}

function parameterOptionalValue(name: string, value: Value, node: ts.Node | undefined) {
  return node != null && ts.isParameter(node) && node.questionToken != null
    ? nullableValue(value, name, 'undefined')
    : value
}

export function unknownResultValue(specs: FitSpec[], program: Program): Value {
  return unknownParamValue(fitReturnInternalRoot, specs, undefined, program)
}

function specParamShape(name: string, specs: FitSpec[]): 'array' | 'object' | 'number' {
  let shape: 'object' | 'number' = 'number'
  for (const spec of specs) {
    if (spec.kind === 'given-range' || spec.kind === 'check-range') {
      const next = specExpressionParamShape(spec.expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
      continue
    }
    if (spec.kind === 'check-expression') {
      const next = specExpressionParamShape(spec.expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
      continue
    }
    if (spec.kind === 'check-value') {
      const next = specExpressionParamShape(spec.expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
      continue
    }
    for (const expression of [spec.left, spec.right]) {
      const next = specExpressionParamShape(expression, name)
      if (next === 'array') return 'array'
      if (next === 'object') shape = 'object'
    }
  }
  return shape
}

function specExpressionParamShape(text: FitExpressionLike, name: string): 'array' | 'object' | 'number' {
  const parsed = fitExpressionParsed(text)
  for (const domainPath of parsed.domainPaths.values()) {
    if (domainPath.root !== name) continue
    return domainPath.segments[0]?.kind === 'item' ? 'array' : 'object'
  }
  if (expressionMentionsArrayParam(parsed.expression, name)) return 'array'
  if (expressionMentionsObjectParam(parsed.expression, name)) return 'object'
  return 'number'
}

export function valueWithBindingShapeFallback(name: ts.BindingName, value: Value, type: ts.TypeNode | undefined, program: Program): Value {
  if (!ts.isIdentifier(name)) return value
  return valueWithStructuralFallback(value, valueFromSyntaxTypeShape(name.text, type, program, new Set()) ?? valueFromNodeShape(name.text, name, program))
}

export function arrayPatternElementValue(value: Value, index: number): Value {
  if (value.kind !== 'array') return unknown(`Array destructuring expected an array`)
  return tupleElements(value)?.[index]
    ?? value.element
    ?? unknownNumber(`${value.expr ?? 'array'}[${index}]`)
}
