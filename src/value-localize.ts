import {
  linearNameForExpression,
  numberValue,
  type NumberValue,
  type Value,
} from './domain.ts'
import {linearVariable} from './linear.ts'
import type {LocalizeOptions} from './check-types.ts'

export function localizeValue(value: Value, expr: string, options: LocalizeOptions = {}): Value {
  if (value.kind === 'number') {
    return numberValue(
      value.min,
      value.max,
      value.isInteger,
      expr,
      options.preserveLinear === true ? value.linear : linearVariable(linearNameForExpression(expr)),
      options.preserveLinear === true ? value.cases : null,
      value.provenance,
    )
  }
  if (value.kind === 'literal') return {...value, expr}
  if (value.kind === 'object') {
    const props = new Map<string, Value>()
    for (const [name, prop] of value.props) props.set(name, localizeValue(prop, `${expr}.${name}`, options))
    return {...value, props, expr}
  }
  if (value.kind === 'array') {
    return {
      ...value,
      length: localizeValue(value.length, `${expr}.length`, options) as NumberValue,
      elements: value.elements == null ? null : value.elements.map((element, index) => localizeValue(element, `${expr}[${index}]`, options)),
      element: value.element == null ? null : localizeValue(value.element, `${expr}[]`, options),
      expr,
    }
  }
  return value
}
