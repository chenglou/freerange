import {
  rationalAdd,
  rationalCompare,
  rationalEquals,
  rationalIsZero,
  rationalMultiply,
  rationalOne,
  rationalSubtract,
  rationalZero,
  type Rational,
} from './rational.ts'

declare const linearBrand: unique symbol

// Coefficients are exact rationals. The atom type belongs to the host using
// the numeric kernel; numeric algebra only needs stable equality.
export type LinearExpr<Atom> = Readonly<{
  constant: Rational
  terms: ReadonlyMap<Atom, Rational>
  [linearBrand]: true
}>

// This is the only constructor from arbitrary terms. Every LinearExpr is
// normalized once, so exact operations never need to clean a caller's input.
export function linearFromTerms<Atom>(constant: Rational, terms: ReadonlyMap<Atom, Rational>): LinearExpr<Atom> {
  const normalizedTerms = new Map<Atom, Rational>()
  for (const [atom, coefficient] of terms) {
    if (!rationalIsZero(coefficient)) normalizedTerms.set(atom, coefficient)
  }
  return normalizedLinear(constant, normalizedTerms)
}

export function linearConstant<Atom>(value: Rational): LinearExpr<Atom> {
  return normalizedLinear(value, new Map())
}

export function linearVariable<Atom>(atom: Atom): LinearExpr<Atom> {
  return normalizedLinear(rationalZero, new Map([[atom, rationalOne]]))
}

export function linearAdd<Atom>(left: LinearExpr<Atom>, right: LinearExpr<Atom>): LinearExpr<Atom> {
  const terms = new Map(left.terms)
  for (const [atom, coefficient] of right.terms) {
    const sum = rationalAdd(terms.get(atom) ?? rationalZero, coefficient)
    if (rationalIsZero(sum)) terms.delete(atom)
    else terms.set(atom, sum)
  }
  return normalizedLinear(rationalAdd(left.constant, right.constant), terms)
}

export function linearSubtract<Atom>(left: LinearExpr<Atom>, right: LinearExpr<Atom>): LinearExpr<Atom> {
  const terms = new Map(left.terms)
  for (const [atom, coefficient] of right.terms) {
    const difference = rationalSubtract(terms.get(atom) ?? rationalZero, coefficient)
    if (rationalIsZero(difference)) terms.delete(atom)
    else terms.set(atom, difference)
  }
  return normalizedLinear(rationalSubtract(left.constant, right.constant), terms)
}

export function linearScale<Atom>(linear: LinearExpr<Atom>, factor: Rational): LinearExpr<Atom> {
  const terms = new Map<Atom, Rational>()
  if (!rationalIsZero(factor)) {
    for (const [atom, coefficient] of linear.terms) {
      const product = rationalMultiply(coefficient, factor)
      if (!rationalIsZero(product)) terms.set(atom, product)
    }
  }
  return normalizedLinear(rationalMultiply(linear.constant, factor), terms)
}

export function sameLinear<Atom>(left: LinearExpr<Atom>, right: LinearExpr<Atom>): boolean {
  if (!rationalEquals(left.constant, right.constant) || left.terms.size !== right.terms.size) return false
  for (const [atom, coefficient] of left.terms) {
    const other = right.terms.get(atom)
    if (other == null || !rationalEquals(coefficient, other)) return false
  }
  return true
}

// The one atom a linear form is (coefficient one, no constant), or null. The
// result is wrapped because null and undefined are valid opaque atom values.
export function singleUnitAtom<Atom>(linear: LinearExpr<Atom>): {atom: Atom} | null {
  if (linear.terms.size !== 1 || !rationalIsZero(linear.constant)) return null
  for (const [atom, coefficient] of linear.terms) {
    return rationalEquals(coefficient, rationalOne) ? {atom} : null
  }
  throw new Error('Linear expression reported one term but had none')
}

export function isZeroLinear<Atom>(linear: LinearExpr<Atom>): boolean {
  return rationalIsZero(linear.constant) && linear.terms.size === 0
}

export function linearConstantStatus<Atom>(linear: LinearExpr<Atom>, strict: boolean): boolean {
  if (linear.terms.size > 0) return false
  const sign = rationalCompare(linear.constant, rationalZero)
  return strict ? sign > 0 : sign >= 0
}

function normalizedLinear<Atom>(constant: Rational, terms: Map<Atom, Rational>): LinearExpr<Atom> {
  return {constant, terms} as unknown as LinearExpr<Atom>
}
