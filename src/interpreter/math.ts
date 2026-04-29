import {
  numberValue,
  unknown,
  type NumberValue,
  type Value,
} from '../domain.ts'
import {noteUnsupported, type InterpreterFrame} from './context.ts'

export function evaluateMathCall(name: string, values: Value[], frame: InterpreterFrame, expressionText: string): Value {
  if (values.some(value => value.kind !== 'number')) return noteUnsupported(frame, `Math.${name} expected number arguments`)
  const numbers = values as NumberValue[]
  switch (name) {
    case 'min':
    case 'max':
      return evaluateMathMinMax(name, numbers)
    case 'floor':
      return evaluateUnaryMath(name, numbers, value => value.isInteger ? value : numberValue(Math.floor(value.min), Math.floor(value.max), true, `floor(${value.expr ?? 'value'})`))
    case 'ceil':
      return evaluateUnaryMath(name, numbers, value => value.isInteger ? value : numberValue(Math.ceil(value.min), Math.ceil(value.max), true, `ceil(${value.expr ?? 'value'})`))
    case 'round':
      return evaluateUnaryMath(name, numbers, value => value.isInteger ? value : numberValue(Math.round(value.min), Math.round(value.max), true, `round(${value.expr ?? 'value'})`))
    case 'trunc':
      return evaluateUnaryMath(name, numbers, value => value.isInteger ? value : numberValue(Math.trunc(value.min), Math.trunc(value.max), true, `trunc(${value.expr ?? 'value'})`))
    case 'sqrt':
      return evaluateUnaryMath(name, numbers, value => value.min < 0 ? unknown('Math.sqrt expected a non-negative number') : numberValue(Math.sqrt(value.min), Math.sqrt(value.max), false, `sqrt(${value.expr ?? 'value'})`))
    case 'abs':
      return evaluateUnaryMath(name, numbers, absNumber)
    case 'sign':
      return evaluateUnaryMath(name, numbers, signNumber)
    default:
      return noteUnsupported(frame, `Unsupported Math.${name} call ${expressionText}`)
  }
}

function evaluateMathMinMax(kind: 'min' | 'max', values: NumberValue[]): Value {
  if (values.length === 0) return unknown(`Math.${kind} expected at least one argument`)
  return values.slice(1).reduce((current, value) => {
    return kind === 'min'
      ? numberValue(Math.min(current.min, value.min), Math.min(current.max, value.max), current.isInteger && value.isInteger, `min(${current.expr ?? 'left'}, ${value.expr ?? 'right'})`)
      : numberValue(Math.max(current.min, value.min), Math.max(current.max, value.max), current.isInteger && value.isInteger, `max(${current.expr ?? 'left'}, ${value.expr ?? 'right'})`)
  }, values[0]!)
}

function evaluateUnaryMath(name: string, values: NumberValue[], evaluate: (value: NumberValue) => Value): Value {
  if (values.length !== 1) return unknown(`Math.${name} expected one argument`)
  return evaluate(values[0]!)
}

function absNumber(value: NumberValue): NumberValue {
  const max = Math.max(Math.abs(value.min), Math.abs(value.max))
  if (value.min >= 0) return value
  if (value.max <= 0) return numberValue(-value.max, -value.min, value.isInteger, `abs(${value.expr ?? 'value'})`)
  return numberValue(0, max, value.isInteger, `abs(${value.expr ?? 'value'})`)
}

function signNumber(value: NumberValue): NumberValue {
  if (value.min === 0 && value.max === 0) return numberValue(0, 0, true, `sign(${value.expr ?? 'value'})`)
  if (value.min > 0) return numberValue(1, 1, true, `sign(${value.expr ?? 'value'})`)
  if (value.max < 0) return numberValue(-1, -1, true, `sign(${value.expr ?? 'value'})`)
  if (value.min >= 0) return numberValue(0, 1, true, `sign(${value.expr ?? 'value'})`)
  if (value.max <= 0) return numberValue(-1, 0, true, `sign(${value.expr ?? 'value'})`)
  return numberValue(-1, 1, true, `sign(${value.expr ?? 'value'})`)
}
