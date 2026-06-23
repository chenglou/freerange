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
import {linearSubtract, type LinearExpr} from './linear.ts'

export type NonNegativeFact<Atom = string> = {
  diff: LinearExpr<Atom>
  strict: boolean
}

// Decides whether `target >= 0` (strict: `target > 0`) follows from the facts
// `fact_i >= 0` / `fact_i > 0` by nonnegative combination — the complete rule
// for linear consequences over the rationals (Farkas' lemma), replacing any
// depth-bounded rewrite search. Deliberately does not exploit inconsistent
// fact sets: only an explicit decomposition target = sum(lambda_i * fact_i) + c
// with lambda, c >= 0 proves, with strictness from a strict fact used at
// lambda_i > 0 or from c > 0.
export function farkasProvesNonNegative<Atom>(target: LinearExpr<Atom>, strict: boolean, facts: NonNegativeFact<Atom>[]): boolean {
  // Trivial decomposition with every lambda zero.
  if (target.terms.size === 0) {
    const sign = rationalCompare(target.constant, rationalZero)
    return strict ? sign > 0 : sign >= 0
  }
  if (facts.length === 0) return false

  // Variables are lambda_1..lambda_n then the constant slack c. One equality
  // row per term name, plus the constant row.
  const atoms = new Set<Atom>()
  for (const atom of target.terms.keys()) atoms.add(atom)
  for (const fact of facts) for (const atom of fact.diff.terms.keys()) atoms.add(atom)
  const rowAtoms = [...atoms]
  const rows: Rational[][] = []
  const rhs: Rational[] = []
  for (const atom of rowAtoms) {
    rows.push([...facts.map(fact => fact.diff.terms.get(atom) ?? rationalZero), rationalZero])
    rhs.push(target.terms.get(atom) ?? rationalZero)
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

export type LinearExtremum<Atom = string> =
  | {kind: 'optimum'; value: Rational; point: Map<Atom, Rational>}
  | {kind: 'supremum'; value: Rational}
  | {kind: 'unbounded'}
  | {kind: 'infeasible'}

// Maximizes `objective` over the valuations satisfying every fact — the same
// polytope Farkas proves over, searched instead of certified. An attained
// optimum includes an admitted point; strict facts may instead produce an
// unattained supremum. Free variables are encoded as differences of two
// nonnegative ones; each fact gets a slack.
export function linearMaximum<Atom>(objective: LinearExpr<Atom>, facts: NonNegativeFact<Atom>[]): LinearExtremum<Atom> {
  const hasStrictFact = facts.some(fact => fact.strict)
  const atoms = new Set<Atom>()
  for (const atom of objective.terms.keys()) atoms.add(atom)
  for (const fact of facts) for (const atom of fact.diff.terms.keys()) atoms.add(atom)
  const variableAtoms = [...atoms]
  const variableColumns = new Map(variableAtoms.map((atom, index) => [atom, index]))
  // columns: x+ per name, x- per name, one slack per fact
  const columnCount = variableAtoms.length * 2 + facts.length
  const columnFor = (atom: Atom) => {
    const column = variableColumns.get(atom)
    if (column == null) throw new Error('Linear atom is missing from the simplex columns')
    return column
  }

  const rows: Rational[][] = []
  const rhs: Rational[] = []
  facts.forEach((fact, factIndex) => {
    const row: Rational[] = Array.from({length: columnCount}, () => rationalZero)
    for (const [atom, coefficient] of fact.diff.terms) {
      row[columnFor(atom)] = coefficient
      row[variableAtoms.length + columnFor(atom)] = rationalNegate(coefficient)
    }
    row[variableAtoms.length * 2 + factIndex] = rationalNegate(rationalOne)
    rows.push(row)
    rhs.push(rationalNegate(fact.diff.constant))
  })

  const objectiveRow: Rational[] = Array.from({length: columnCount}, () => rationalZero)
  for (const [atom, coefficient] of objective.terms) {
    objectiveRow[columnFor(atom)] = coefficient
    objectiveRow[variableAtoms.length + columnFor(atom)] = rationalNegate(coefficient)
  }

  const solved = solveSimplex(rows, rhs, objectiveRow)
  if (solved == null) return {kind: 'infeasible'}
  if (solved.unbounded) {
    return hasStrictFact && linearFeasiblePoint(facts) == null
      ? {kind: 'infeasible'}
      : {kind: 'unbounded'}
  }
  const point = pointFromSolution(variableAtoms, solved.point)
  const value = rationalAdd(solved.objectiveValue, objective.constant)
  if (!hasStrictFact || pointSatisfiesFacts(point, facts)) return {kind: 'optimum', value, point}
  if (linearFeasiblePoint(facts) == null) return {kind: 'infeasible'}

  const maximum = {constant: value, terms: new Map<Atom, Rational>()}
  const attainingPoint = linearFeasiblePoint([
    ...facts,
    {diff: linearSubtract(objective, maximum)!, strict: false},
    {diff: linearSubtract(maximum, objective)!, strict: false},
  ])
  return attainingPoint == null
    ? {kind: 'supremum', value}
    : {kind: 'optimum', value, point: attainingPoint}
}

// Finds one rational valuation satisfying every closed and strict fact. A
// shared positive margin handles strict inequalities without pretending their
// excluded boundaries are feasible.
export function linearFeasiblePoint<Atom>(facts: NonNegativeFact<Atom>[]): Map<Atom, Rational> | null {
  if (!facts.some(fact => fact.strict)) {
    const zero: LinearExpr<Atom> = {constant: rationalZero, terms: new Map()}
    const solved = linearMaximum(zero, facts)
    return solved.kind === 'optimum' ? solved.point : null
  }

  const atoms = new Set<Atom>()
  for (const fact of facts) for (const atom of fact.diff.terms.keys()) atoms.add(atom)
  const variableAtoms = [...atoms]
  const variableColumns = new Map<Atom, number>()
  variableAtoms.forEach((atom, index) => variableColumns.set(atom, index))
  const marginColumn = variableAtoms.length * 2
  const slackStart = marginColumn + 1
  const columnCount = slackStart + facts.length + 1
  const columnFor = (atom: Atom) => {
    const column = variableColumns.get(atom)
    if (column == null) throw new Error('Linear atom is missing from the simplex columns')
    return column
  }

  const rows: Rational[][] = []
  const rhs: Rational[] = []
  facts.forEach((fact, factIndex) => {
    const row: Rational[] = Array.from({length: columnCount}, () => rationalZero)
    for (const [atom, coefficient] of fact.diff.terms) {
      const column = columnFor(atom)
      row[column] = coefficient
      row[variableAtoms.length + column] = rationalNegate(coefficient)
    }
    if (fact.strict) row[marginColumn] = rationalNegate(rationalOne)
    row[slackStart + factIndex] = rationalNegate(rationalOne)
    rows.push(row)
    rhs.push(rationalNegate(fact.diff.constant))
  })

  // Cap the shared margin at one. Its exact size does not matter; a finite set
  // of strict rational inequalities is feasible iff some positive margin is.
  const marginUpperBound: Rational[] = Array.from({length: columnCount}, () => rationalZero)
  marginUpperBound[marginColumn] = rationalNegate(rationalOne)
  marginUpperBound[slackStart + facts.length] = rationalNegate(rationalOne)
  rows.push(marginUpperBound)
  rhs.push(rationalNegate(rationalOne))

  const objective: Rational[] = Array.from({length: columnCount}, () => rationalZero)
  objective[marginColumn] = rationalOne
  const solved = solveSimplex(rows, rhs, objective)
  if (solved == null || solved.unbounded || !rationalIsPositive(solved.objectiveValue)) return null
  return pointFromSolution(variableAtoms, solved.point)
}

function pointFromSolution<Atom>(variableAtoms: Atom[], solvedPoint: Rational[]): Map<Atom, Rational> {
  const point = new Map<Atom, Rational>()
  variableAtoms.forEach((atom, index) => {
    const positive = solvedPoint[index] ?? rationalZero
    const negative = solvedPoint[variableAtoms.length + index] ?? rationalZero
    point.set(atom, rationalSubtract(positive, negative))
  })
  return point
}

function pointSatisfiesFacts<Atom>(point: Map<Atom, Rational>, facts: NonNegativeFact<Atom>[]): boolean {
  for (const fact of facts) {
    let value = fact.diff.constant
    for (const [atom, coefficient] of fact.diff.terms) {
      value = rationalAdd(value, rationalMultiply(coefficient, point.get(atom) ?? rationalZero))
    }
    const comparison = rationalCompare(value, rationalZero)
    if (fact.strict ? comparison <= 0 : comparison < 0) return false
  }
  return true
}

type SimplexResult = {
  objectiveValue: Rational
  unbounded: boolean
  point: Rational[]
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
  const reduced = reducedCosts(tableau, basis, objective)
  for (;;) {
    let entering = -1
    for (let column = 0; column < pivotColumnLimit; column++) {
      if (rationalIsPositive(reduced[column]!)) {
        entering = column
        break
      }
    }
    if (entering === -1) {
      return {objectiveValue: objectiveValueAt(tableau, basis, objective), unbounded: false, point: basicPoint(tableau, basis, objective.length)}
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
    if (leaving === -1) return {objectiveValue: rationalZero, unbounded: true, point: []}
    const enteringCost = reduced[entering]!
    pivot(tableau, basis, leaving, entering)
    const pivotRow = tableau[leaving]!
    for (let column = 0; column < reduced.length; column++) {
      reduced[column] = rationalSubtract(reduced[column]!, rationalMultiply(enteringCost, pivotRow[column]!))
    }
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

// Values of the original (non-artificial) variables at the current basis.
function basicPoint(tableau: Rational[][], basis: number[], columnCount: number): Rational[] {
  const point: Rational[] = Array.from({length: columnCount}, () => rationalZero)
  for (let row = 0; row < tableau.length; row++) {
    const column = basis[row]!
    if (column < columnCount) point[column] = rightHandSide(tableau[row]!)
  }
  return point
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
