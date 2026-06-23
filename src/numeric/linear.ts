import {
  rationalAdd,
  rationalCompare,
  rationalDivide,
  rationalEquals,
  rationalFromNumber,
  rationalIsZero,
  rationalMultiply,
  rationalNegate,
  rationalOne,
  rationalZero,
  type Rational,
} from './rational.ts'

// Coefficients are exact rationals. The atom type belongs to the host using
// the numeric kernel; numeric algebra only needs stable equality.
export type LinearExpr<Atom = string> = {
  constant: Rational
  terms: Map<Atom, Rational>
}

// Infinity and NaN have no linear form.
export function linearConstant<Atom = string>(value: number): LinearExpr<Atom> | null {
  const constant = rationalFromNumber(value)
  return constant == null ? null : {constant, terms: new Map()}
}

export function linearVariable<Atom>(atom: Atom): LinearExpr<Atom> {
  return {constant: rationalZero, terms: new Map([[atom, rationalOne]])}
}

export function linearAdd<Atom>(left: LinearExpr<Atom> | null, right: LinearExpr<Atom> | null): LinearExpr<Atom> | null {
  if (left == null || right == null) return null
  const terms = new Map(left.terms)
  for (const [atom, coefficient] of right.terms) {
    terms.set(atom, rationalAdd(terms.get(atom) ?? rationalZero, coefficient))
  }
  return cleanLinear({constant: rationalAdd(left.constant, right.constant), terms})
}

export function linearSubtract<Atom>(left: LinearExpr<Atom> | null, right: LinearExpr<Atom> | null): LinearExpr<Atom> | null {
  if (left == null || right == null) return null
  return linearAdd(left, linearScaleExact(right, rationalNegate(rationalOne)))
}

export function linearScale<Atom>(linear: LinearExpr<Atom> | null, factor: number): LinearExpr<Atom> | null {
  if (linear == null) return null
  const rationalFactor = rationalFromNumber(factor)
  return rationalFactor == null ? null : linearScaleExact(linear, rationalFactor)
}

export function linearDivide<Atom>(linear: LinearExpr<Atom> | null, divisor: number): LinearExpr<Atom> | null {
  if (linear == null) return null
  const rationalDivisor = rationalFromNumber(divisor)
  if (rationalDivisor == null || rationalIsZero(rationalDivisor)) return null
  const inverse = rationalDivide(rationalOne, rationalDivisor)
  return inverse == null ? null : linearScaleExact(linear, inverse)
}

export function linearScaleExact<Atom>(linear: LinearExpr<Atom>, factor: Rational): LinearExpr<Atom> {
  const terms = new Map<Atom, Rational>()
  for (const [atom, coefficient] of linear.terms) terms.set(atom, rationalMultiply(coefficient, factor))
  return cleanLinear({constant: rationalMultiply(linear.constant, factor), terms})
}

export function sameLinear<Atom>(left: LinearExpr<Atom>, right: LinearExpr<Atom>): boolean {
  const diff = linearSubtract(left, right)
  return diff != null && isZeroLinear(diff)
}

// The one atom a linear form is (coefficient one, no constant), or null. The
// result is wrapped because null and undefined are valid opaque atom values.
export function singleUnitAtom<Atom>(linear: LinearExpr<Atom> | null): {atom: Atom} | null {
  if (linear == null || linear.terms.size !== 1 || !rationalIsZero(linear.constant)) return null
  const [atom, coefficient] = [...linear.terms.entries()][0]!
  return rationalEquals(coefficient, rationalOne) ? {atom} : null
}

// Removes exactly-zero terms; nothing else is droppable.
export function cleanLinear<Atom>(linear: LinearExpr<Atom>): LinearExpr<Atom> {
  const terms = new Map<Atom, Rational>()
  for (const [atom, coefficient] of linear.terms) {
    if (!rationalIsZero(coefficient)) terms.set(atom, coefficient)
  }
  return {constant: linear.constant, terms}
}

export function isZeroLinear<Atom>(linear: LinearExpr<Atom>): boolean {
  return rationalIsZero(linear.constant) && linear.terms.size === 0
}

export function linearConstantStatus<Atom>(linear: LinearExpr<Atom>, strict: boolean): boolean {
  if (linear.terms.size > 0) return false
  const sign = rationalCompare(linear.constant, rationalZero)
  return strict ? sign > 0 : sign >= 0
}
