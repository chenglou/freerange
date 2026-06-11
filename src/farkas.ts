import {
  rationalAdd,
  rationalCompare,
  rationalDivide,
  rationalIsNegative,
  rationalIsPositive,
  rationalIsZero,
  rationalMultiply,
  rationalNegate,
  rationalOne,
  rationalSubtract,
  rationalZero,
  type Rational,
} from './rational.ts'
import type {LinearExpr} from './linear.ts'

export type NonNegativeFact = {
  diff: LinearExpr
  strict: boolean
}

// Decides whether `target >= 0` (strict: `target > 0`) follows from the facts
// `fact_i >= 0` / `fact_i > 0` by nonnegative combination — the complete rule
// for linear consequences over the rationals (Farkas' lemma), replacing any
// depth-bounded rewrite search. Deliberately does not exploit inconsistent
// fact sets: only an explicit decomposition target = sum(lambda_i * fact_i) + c
// with lambda, c >= 0 proves, with strictness from a strict fact used at
// lambda_i > 0 or from c > 0.
export function farkasProvesNonNegative(target: LinearExpr, strict: boolean, facts: NonNegativeFact[]): boolean {
  // Trivial decomposition with every lambda zero.
  if (target.terms.size === 0) {
    const sign = rationalCompare(target.constant, rationalZero)
    return strict ? sign > 0 : sign >= 0
  }
  if (facts.length === 0) return false

  // Variables are lambda_1..lambda_n then the constant slack c. One equality
  // row per term name, plus the constant row.
  const names = new Set<string>()
  for (const name of target.terms.keys()) names.add(name)
  for (const fact of facts) for (const name of fact.diff.terms.keys()) names.add(name)
  const rowNames = [...names]
  const rows: Rational[][] = []
  const rhs: Rational[] = []
  for (const name of rowNames) {
    rows.push([...facts.map(fact => fact.diff.terms.get(name) ?? rationalZero), rationalZero])
    rhs.push(target.terms.get(name) ?? rationalZero)
  }
  rows.push([...facts.map(fact => fact.diff.constant), rationalOne])
  rhs.push(target.constant)

  // Strictness arrives through a strict fact taken positively or through
  // leftover constant slack; maximize their sum and ask for a positive value.
  const objective: Rational[] = [...facts.map(fact => fact.strict ? rationalOne : rationalZero), rationalOne]

  const solved = solveSimplex(rows, rhs, objective)
  if (solved == null) return false
  if (!strict) return true
  return solved.unbounded || rationalIsPositive(solved.objectiveValue)
}

type SimplexResult = {
  objectiveValue: Rational
  unbounded: boolean
}

// Two-phase simplex with Bland's rule (exact rationals, no cycling). Maximizes
// objective . x subject to rows . x = rhs, x >= 0. Returns null when
// infeasible.
function solveSimplex(rows: Rational[][], rhs: Rational[], objective: Rational[]): SimplexResult | null {
  const rowCount = rows.length
  const columnCount = objective.length

  // Make every right-hand side nonnegative, then add one artificial variable
  // per row to get a starting basis.
  const tableau: Rational[][] = []
  for (let row = 0; row < rowCount; row++) {
    const negate = rationalIsNegative(rhs[row]!)
    const line = rows[row]!.map(value => negate ? rationalNegate(value) : value)
    for (let artificial = 0; artificial < rowCount; artificial++) {
      line.push(artificial === row ? rationalOne : rationalZero)
    }
    line.push(negate ? rationalNegate(rhs[row]!) : rhs[row]!)
    tableau.push(line)
  }
  const totalColumns = columnCount + rowCount
  const basis: number[] = []
  for (let row = 0; row < rowCount; row++) basis.push(columnCount + row)

  // Phase 1: minimize the artificial sum (maximize its negation).
  const phaseOne: Rational[] = []
  for (let column = 0; column < totalColumns; column++) {
    phaseOne.push(column >= columnCount ? rationalNegate(rationalOne) : rationalZero)
  }
  const phaseOneValue = optimize(tableau, basis, phaseOne, totalColumns)
  if (phaseOneValue == null || !rationalIsZero(phaseOneValue.objectiveValue)) return null

  // Drive any artificial variables still in the basis out, or drop their rows
  // when degenerate.
  for (let row = 0; row < tableau.length; row++) {
    if (basis[row]! < columnCount) continue
    let pivoted = false
    for (let column = 0; column < columnCount; column++) {
      if (!rationalIsZero(tableau[row]![column]!)) {
        pivot(tableau, basis, row, column)
        pivoted = true
        break
      }
    }
    if (!pivoted) {
      tableau.splice(row, 1)
      basis.splice(row, 1)
      row--
    }
  }

  // Phase 2 over the original columns only.
  const phaseTwo: Rational[] = []
  for (let column = 0; column < totalColumns; column++) {
    phaseTwo.push(column < columnCount ? objective[column]! : rationalZero)
  }
  return optimize(tableau, basis, phaseTwo, columnCount)
}

function optimize(tableau: Rational[][], basis: number[], objective: Rational[], pivotColumnLimit: number): SimplexResult | null {
  for (;;) {
    const reduced = reducedCosts(tableau, basis, objective)
    let entering = -1
    for (let column = 0; column < pivotColumnLimit; column++) {
      if (rationalIsPositive(reduced[column]!)) {
        entering = column
        break
      }
    }
    if (entering === -1) {
      return {objectiveValue: objectiveValueAt(tableau, basis, objective), unbounded: false}
    }
    let leaving = -1
    let bestRatio: Rational | null = null
    for (let row = 0; row < tableau.length; row++) {
      const coefficient = tableau[row]![entering]!
      if (!rationalIsPositive(coefficient)) continue
      const ratio = rationalDivide(rightHandSide(tableau[row]!), coefficient)!
      if (bestRatio == null || rationalCompare(ratio, bestRatio) < 0
        || (rationalCompare(ratio, bestRatio) === 0 && basis[row]! < basis[leaving]!)) {
        bestRatio = ratio
        leaving = row
      }
    }
    if (leaving === -1) return {objectiveValue: rationalZero, unbounded: true}
    pivot(tableau, basis, leaving, entering)
  }
}

function reducedCosts(tableau: Rational[][], basis: number[], objective: Rational[]): Rational[] {
  const columns = objective.length
  const costs: Rational[] = []
  for (let column = 0; column < columns; column++) {
    let value = objective[column]!
    for (let row = 0; row < tableau.length; row++) {
      const basisCost = objective[basis[row]!]!
      if (rationalIsZero(basisCost)) continue
      value = rationalSubtract(value, rationalMultiply(basisCost, tableau[row]![column]!))
    }
    costs.push(value)
  }
  return costs
}

function objectiveValueAt(tableau: Rational[][], basis: number[], objective: Rational[]): Rational {
  let value = rationalZero
  for (let row = 0; row < tableau.length; row++) {
    const cost = objective[basis[row]!]!
    if (rationalIsZero(cost)) continue
    value = rationalAdd(value, rationalMultiply(cost, rightHandSide(tableau[row]!)))
  }
  return value
}

function rightHandSide(row: Rational[]): Rational {
  return row[row.length - 1]!
}

function pivot(tableau: Rational[][], basis: number[], pivotRow: number, pivotColumn: number) {
  const row = tableau[pivotRow]!
  const factor = row[pivotColumn]!
  for (let column = 0; column < row.length; column++) {
    row[column] = rationalDivide(row[column]!, factor)!
  }
  for (let other = 0; other < tableau.length; other++) {
    if (other === pivotRow) continue
    const target = tableau[other]!
    const scale = target[pivotColumn]!
    if (rationalIsZero(scale)) continue
    for (let column = 0; column < target.length; column++) {
      target[column] = rationalSubtract(target[column]!, rationalMultiply(scale, row[column]!))
    }
  }
  basis[pivotRow] = pivotColumn
}
