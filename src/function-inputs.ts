import * as ts from 'typescript'
import {
  bindingElementPropertyName,
  forEachArrayBindingElement,
} from './binding-patterns.ts'
import {
  tupleElements,
  nullableValue,
  unknown,
  type Value,
} from './domain.ts'
import {functionHasInstanceThisInput} from './function-shape.ts'
import {
  valueFromNodeType,
  valueFromTypeNode,
} from './shapes.ts'
import type {LocalizeOptions, Program} from './check-types.ts'
import type {FitFunction} from './modules.ts'
import {localizeValue} from './value-localize.ts'

export function bindFunctionInputParameters(fn: FitFunction, program: Program, env: Map<string, Value>) {
  if (functionHasInstanceThisInput(fn)) {
    env.set('this', unknownParamValue('this', undefined, program))
  }
  for (const param of fn.node.parameters) {
    if (ts.isIdentifier(param.name)) {
      env.set(param.name.text, unknownParamValue(param.name.text, param.type, program, param))
      continue
    }
    bindPatternFromValue(param.name, unknownParamPatternValue(param, program), env, {}, program)
  }
}

function unknownParamPatternValue(param: ts.ParameterDeclaration, program: Program): Value {
  return valueFromNodeType('param', param.name, program)
    ?? valueFromTypeNode('param', param.type, program)
    ?? unknown(`Parameter ${param.name.getText(program.sourceFile)} needs a TypeScript type or an explicit @fit range`)
}

export function bindPatternFromValue(name: ts.BindingName, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}, program?: Program) {
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
      const typed = program == null ? null : valueFromNodeType(element.name.getText(program.sourceFile), element.name, program)
      const prop = value.kind === 'object'
        ? value.props.get(propertyName) ?? bindingPropertyFallback(value, propertyName, typed)
        : unknown(`Destructuring property ${propertyName} expected an object`)
      bindPatternFromValue(element.name, prop, env, options, program)
    }
    return
  }
  if (ts.isArrayBindingPattern(name)) {
    bindArrayPatternFromValue(name, value, env, options, program)
    return
  }
  bindUnknownPattern(name, env)
}

function bindArrayPatternFromValue(name: ts.ArrayBindingPattern, value: Value, env: Map<string, Value>, options: LocalizeOptions = {}, program?: Program) {
  forEachArrayBindingElement(name, (elementName, index, isRest) => {
    if (isRest) {
      bindUnknownPattern(elementName, env)
      return
    }
    const typed = program == null ? null : valueFromNodeType(elementName.getText(program.sourceFile), elementName, program)
    const item = valueWithTypeFallback(arrayPatternElementValue(value, index), typed)
    bindPatternFromValue(elementName, item, env, options, program)
  })
}

function bindUnknownPattern(name: ts.BindingName, env: Map<string, Value>) {
  if (ts.isIdentifier(name)) {
    env.set(name.text, unknown(`${name.text} was not inferred from binding pattern`))
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

export function unknownParamValue(name: string, type: ts.TypeNode | undefined, program: Program, node?: ts.Node): Value {
  const typed = valueFromTypeNode(name, type, program)
    ?? (type == null && node != null ? valueFromNodeType(name, node, program) : null)
  if (typed != null) return parameterOptionalValue(name, typed, node)

  return unknown(`Parameter ${name} needs a TypeScript type or an explicit @fit range`)
}

function parameterOptionalValue(name: string, value: Value, node: ts.Node | undefined) {
  return node != null && ts.isParameter(node) && node.questionToken != null
    ? nullableValue(value, name, 'undefined')
    : value
}

export function unknownResultValue(): Value {
  return unknown(`Return value was not evaluated`)
}

export function arrayPatternElementValue(value: Value, index: number): Value {
  if (value.kind !== 'array') return unknown(`Array destructuring expected an array`)
  return tupleElements(value)?.[index]
    ?? value.element
    ?? unknown(`${value.expr ?? 'array'}[${index}] was not inferred`)
}

function valueWithTypeFallback(value: Value, typed: Value | null): Value {
  return value.kind === 'unknown' && typed != null ? typed : value
}

function bindingPropertyFallback(target: Value, propertyName: string, typed: Value | null): Value {
  if (typed != null && target.kind === 'object' && target.expr != null) return localizeValue(typed, `${target.expr}.${propertyName}`)
  return typed ?? unknown(`Property ${propertyName} was not inferred`)
}
