export type AbstractNumber = {
  kind: 'number'
  lower: number
  upper: number
  integer: boolean
  finite: boolean
  mayBeNaN: boolean
}

export type AbstractBoolean = {
  kind: 'boolean'
  canBeTrue: boolean
  canBeFalse: boolean
}

type AbstractObjectProperty = {
  name: string
  value: AbstractValue
}

export type AbstractObject = {
  properties: AbstractObjectProperty[]
}

export type AbstractReference = {
  kind: 'reference'
  allocation: number
}

type AbstractVoid = {
  kind: 'void'
}

export type AbstractHeap = AbstractObject[]

export type AbstractValue = AbstractNumber | AbstractBoolean | AbstractReference | AbstractVoid

export function finiteInputNumber(): AbstractNumber {
  return {
    kind: 'number',
    lower: -Number.MAX_VALUE,
    upper: Number.MAX_VALUE,
    integer: false,
    finite: true,
    mayBeNaN: false,
  }
}

export function constantNumber(value: number): AbstractNumber {
  return {
    kind: 'number',
    lower: value,
    upper: value,
    integer: Number.isInteger(value),
    finite: Number.isFinite(value),
    mayBeNaN: Number.isNaN(value),
  }
}

export function addNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return boundedResult(
    left.lower + right.lower,
    left.upper + right.upper,
    left.integer && right.integer,
    left,
    right,
  )
}

export function subtractNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return boundedResult(
    left.lower - right.upper,
    left.upper - right.lower,
    left.integer && right.integer,
    left,
    right,
  )
}

export function multiplyNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right)) return unknownNumber()
  const products = [
    left.lower * right.lower,
    left.lower * right.upper,
    left.upper * right.lower,
    left.upper * right.upper,
  ]
  return boundedResult(Math.min(...products), Math.max(...products), left.integer && right.integer, left, right)
}

export function divideNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right) || includesZero(right)) return unknownNumber()
  const quotients = [
    left.lower / right.lower,
    left.lower / right.upper,
    left.upper / right.lower,
    left.upper / right.upper,
  ]
  return boundedResult(Math.min(...quotients), Math.max(...quotients), false, left, right)
}

export function floorNumber(value: AbstractNumber): AbstractNumber {
  if (!value.finite || value.mayBeNaN) return unknownNumber()
  return boundedResult(Math.floor(value.lower), Math.floor(value.upper), true, value)
}

export function minimumNumbers(values: AbstractNumber[]): AbstractNumber {
  if (values.length === 0 || values.some(value => !value.finite || value.mayBeNaN)) return unknownNumber()
  return boundedResult(
    Math.min(...values.map(value => value.lower)),
    Math.min(...values.map(value => value.upper)),
    values.every(value => value.integer),
    ...values,
  )
}

export function maximumNumbers(values: AbstractNumber[]): AbstractNumber {
  if (values.length === 0 || values.some(value => !value.finite || value.mayBeNaN)) return unknownNumber()
  return boundedResult(
    Math.max(...values.map(value => value.lower)),
    Math.max(...values.map(value => value.upper)),
    values.every(value => value.integer),
    ...values,
  )
}

export function includesZero(value: AbstractNumber): boolean {
  return value.lower <= 0 && value.upper >= 0
}

function boundedResult(
  lower: number,
  upper: number,
  integer: boolean,
  ...operands: AbstractNumber[]
): AbstractNumber {
  const finite = operands.every(value => value.finite && !value.mayBeNaN)
    && Number.isFinite(lower)
    && Number.isFinite(upper)
  if (!finite) return unknownNumber()
  return {kind: 'number', lower, upper, integer, finite: true, mayBeNaN: false}
}

function safeOperands(left: AbstractNumber, right: AbstractNumber): boolean {
  return left.finite && right.finite && !left.mayBeNaN && !right.mayBeNaN
}

function unknownNumber(): AbstractNumber {
  return {
    kind: 'number',
    lower: Number.NEGATIVE_INFINITY,
    upper: Number.POSITIVE_INFINITY,
    integer: false,
    finite: false,
    mayBeNaN: true,
  }
}
