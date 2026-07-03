export type AbstractNumber = {
  kind: 'number'
  lower: number
  upper: number
  integer: boolean
  finite: boolean
  mayBeNaN: boolean
}

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

// Division once a nonzero requirement has been recorded for the divisor: the divisor's
// range with zero cut out. An integer divisor then has magnitude at least 1, so the
// quotient is bounded by the dividend's magnitude — genuinely finite. A non-integer
// divisor can still be arbitrarily close to zero, so the quotient can overflow; the
// result is possibly non-finite but never NaN (a finite dividend over a nonzero finite
// divisor has no NaN case).
export function divideNumbersNonzeroDivisor(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  if (!safeOperands(left, right)) return unknownNumber()
  if (!includesZero(right)) return divideNumbers(left, right)
  if (!right.integer) {
    return {kind: 'number', lower: -Infinity, upper: Infinity, integer: false, finite: false, mayBeNaN: false}
  }
  const negativePart: AbstractNumber = {...right, upper: Math.min(right.upper, -1)}
  const positivePart: AbstractNumber = {...right, lower: Math.max(right.lower, 1)}
  const parts = [negativePart, positivePart].filter(part => part.lower <= part.upper)
  const quotients = parts.flatMap(part => [
    left.lower / part.lower,
    left.lower / part.upper,
    left.upper / part.lower,
    left.upper / part.upper,
  ])
  if (quotients.length === 0) return unknownNumber()
  return boundedResult(Math.min(...quotients), Math.max(...quotients), false, left, right)
}

export function absoluteNumber(value: AbstractNumber): AbstractNumber {
  // Even a possibly non-finite or NaN input keeps the one fact abs guarantees: no result
  // below zero (abs(NaN) is NaN, which the mayBeNaN flag carries separately).
  if (!value.finite || value.mayBeNaN) {
    return {kind: 'number', lower: 0, upper: Infinity, integer: value.integer, finite: value.finite, mayBeNaN: value.mayBeNaN}
  }
  if (value.lower >= 0) return value
  if (value.upper <= 0) return boundedResult(-value.upper, -value.lower, value.integer, value)
  return boundedResult(0, Math.max(-value.lower, value.upper), value.integer, value)
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

export function joinNumbers(left: AbstractNumber, right: AbstractNumber): AbstractNumber {
  return {
    kind: 'number',
    lower: Math.min(left.lower, right.lower),
    upper: Math.max(left.upper, right.upper),
    integer: left.integer && right.integer,
    finite: left.finite && right.finite,
    mayBeNaN: left.mayBeNaN || right.mayBeNaN,
  }
}

export function sameNumbers(left: AbstractNumber, right: AbstractNumber): boolean {
  return left.lower === right.lower
    && left.upper === right.upper
    && left.integer === right.integer
    && left.finite === right.finite
    && left.mayBeNaN === right.mayBeNaN
}

export function widenNumber(previous: AbstractNumber, next: AbstractNumber): AbstractNumber {
  const finite = previous.finite && next.finite
  return {
    ...next,
    lower: next.lower < previous.lower
      ? finite ? -Number.MAX_VALUE : Number.NEGATIVE_INFINITY
      : next.lower,
    upper: next.upper > previous.upper
      ? finite ? Number.MAX_VALUE : Number.POSITIVE_INFINITY
      : next.upper,
  }
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
