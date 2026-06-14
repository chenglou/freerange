import {
  rationalAdd,
  rationalCompare,
  rationalDivide,
  rationalFromNumber,
  rationalIsExactNumber,
  rationalMultiply,
  rationalOne,
  rationalToNumber,
  type Rational,
} from './rational.ts'
import {
  domainPathSyntheticName,
  parseDomainPathText,
} from './parser.ts'
import {
  cleanLinear,
  linearAdd,
  linearConstant,
  linearScale,
  linearScaleExact,
  linearSubtract,
  linearVariable,
  sameLinear,
  type LinearExpr,
} from './linear.ts'
import type {
  LiteralValue,
  NumberCase,
  NumberCaseLoss,
  NumberCaseSource,
  NumberComputation,
  NumberValue,
  UnknownValue,
  Value,
} from './domain-types.ts'

export const maxNumberCases = 8

export function numberCaseLossMessage(loss: NumberCaseLoss) {
  switch (loss.kind) {
    case 'limit':
      return `Numeric alternative budget exceeded: ${loss.count} alternatives exceed limit ${loss.limit}`
    case 'branch':
      return `Numeric alternatives from ${loss.condition} could not be correlated through this computation`
  }
}

export function linearNameForExpression(text: string) {
  const domainPath = parseDomainPathText(text)
  return domainPath?.segments.some(segment => segment.kind === 'item') === true ? domainPathSyntheticName(text) : text
}

// A value pinned to zero sits on every grid; coarser than any nonzero
// double's grid (whose exponents reach 1024 - 53 at most).
const zeroGrid = 1075

export function integerValued(value: NumberValue): boolean {
  return value.grid != null && value.grid >= 0
}

// NaN has no representation in the domain: any constraining fact is false of
// it (NaN fails every comparison), so a value with at least one finite bound
// cannot be NaN at runtime. Only the fully unconstrained hull admits it, and
// an op that proved its operands avoid the indeterminate forms opts back out
// with neverNaN (overflow to ±Infinity stays possible, NaN does not).
export function possiblyNaN(value: NumberValue): boolean {
  return value.neverNaN !== true && value.min === Number.NEGATIVE_INFINITY && value.max === Number.POSITIVE_INFINITY
}

// Attach the NaN exclusion an op just proved. Only a fully unbounded hull
// needs it; any finite bound already excludes NaN.
function neverNaNResult(value: NumberValue, certain: boolean): NumberValue {
  return certain && value.min === Number.NEGATIVE_INFINITY && value.max === Number.POSITIVE_INFINITY
    ? {...value, neverNaN: true}
    : value
}

// Union of two values keeps only the grid both sit on (the finer exponent);
// intersection keeps the coarser of the two claims.
export function gridJoin(left: number | null, right: number | null): number | null {
  return left == null || right == null ? null : Math.min(left, right)
}

export function gridMeet(left: number | null, right: number | null): number | null {
  if (left == null) return right
  if (right == null) return left
  return Math.max(left, right)
}

// The finest dyadic grid one double sits on: value = m * 2^grid with m odd.
export function gridOfNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null
  if (value === 0) return zeroGrid
  const rational = rationalFromNumber(value)!
  let num = rational.num < 0n ? -rational.num : rational.num
  let grid = 0
  while ((num & 1n) === 0n) {
    num >>= 1n
    grid++
  }
  let den = rational.den
  while (den > 1n) {
    den >>= 1n
    grid--
  }
  return grid
}

// 2^(53+grid) bounds the magnitudes where every multiple of 2^grid is
// representable. An exact real result on the grid and inside the window IS
// what the runtime returns (ECMA defines + - * / as round-of-exact-real), so
// the op rounds nothing and its algebraic linear form is the runtime double.
export function withinGridWindow(magnitude: Rational, grid: number): boolean {
  const exponent = 53 + grid
  const threshold: Rational = exponent >= 0
    ? {num: 1n << BigInt(exponent), den: 1n}
    : {num: 1n, den: 1n << BigInt(-exponent)}
  return rationalCompare(magnitude, threshold) <= 0
}

// Largest magnitude the hull admits, exactly; null when unbounded.
function maxAbsRational(value: NumberValue): Rational | null {
  if (!Number.isFinite(value.min) || !Number.isFinite(value.max)) return null
  return rationalFromNumber(Math.max(Math.abs(value.min), Math.abs(value.max)))
}

// |value| is exactly 2^k for some k: the normalized denominator is always a
// power of two, so this is just the numerator's odd part being one.
function powerOfTwoMagnitude(value: number): boolean {
  const rational = rationalFromNumber(value)
  if (rational == null || rational.num === 0n) return false
  const num = rational.num < 0n ? -rational.num : rational.num
  return (num & (num - 1n)) === 0n
}

function sumIsExact(left: NumberValue, right: NumberValue, grid: number | null): boolean {
  if (grid == null || left.linear == null || right.linear == null) return false
  const leftMagnitude = maxAbsRational(left)
  const rightMagnitude = maxAbsRational(right)
  if (leftMagnitude == null || rightMagnitude == null) return false
  return withinGridWindow(rationalAdd(leftMagnitude, rightMagnitude), grid)
}

// True when the program's a + b (or a - b) provably rounds nothing, so its
// algebraic form is the runtime double.
export function additionIsExact(left: NumberValue, right: NumberValue): boolean {
  return sumIsExact(left, right, gridJoin(left.grid, right.grid))
}

// A rounded result with no algebraic identity still denotes one double per
// evaluation; naming it by its source expression lets identical computations
// (echo claims, recorded branch facts) connect without claiming any algebra.
function opaqueLinear(expr: string | null): LinearExpr | null {
  return expr == null ? null : linearVariable(linearNameForExpression(expr))
}

// Both operands pinned to one finite double each: the op folds to the exact
// IEEE result, like source literals do.
function foldBinary(
  left: NumberValue,
  right: NumberValue,
  apply: (left: number, right: number) => number,
  expr: string | null,
  origin: string[],
): NumberValue | null {
  if (left.min !== left.max || right.min !== right.max) return null
  if (!Number.isFinite(left.min) || !Number.isFinite(right.min)) return null
  const result = apply(left.min, right.min)
  if (Number.isNaN(result)) return null
  return numberValue(result, result, gridOfNumber(result), expr, linearConstant(result), null, origin)
}

export function numberValue(
  min: number,
  max: number,
  grid: number | null,
  expr: string | null,
  linear: LinearExpr | null = null,
  cases: NumberCase[] | null = null,
  origin: string[] = [],
  computation: NumberComputation | null = null,
): NumberValue {
  const clean = linear == null ? null : cleanLinear(linear)
  const cleanOrigin = [...new Set(origin)]
  const cleanMin = Number.isNaN(min) ? Number.NEGATIVE_INFINITY : min
  const cleanMax = Number.isNaN(max) ? Number.POSITIVE_INFINITY : max
  if (clean != null && clean.terms.size === 0 && rationalIsExactNumber(clean.constant)) {
    const exact = rationalToNumber(clean.constant)
    return {kind: 'number', min: exact, max: exact, grid: gridOfNumber(exact), expr, linear: clean, computation, cases, origin: cleanOrigin}
  }
  if (cleanMin > cleanMax) {
    return {kind: 'number', min: Number.NEGATIVE_INFINITY, max: Number.POSITIVE_INFINITY, grid: null, expr, linear: clean, computation, cases, origin: cleanOrigin}
  }
  return {kind: 'number', min: cleanMin, max: cleanMax, grid, expr, linear: clean, computation, cases, origin: cleanOrigin}
}

export function finiteNumberValue(
  values: number[],
  expr: string | null,
  linear: LinearExpr | null = expr == null ? null : linearVariable(linearNameForExpression(expr)),
  origin: string[] = [],
): NumberValue {
  const finiteValues = finiteNumberSetValues(values)
  if (finiteValues.length === 0) return unknownNumber(expr ?? '<empty finite set>')
  const min = finiteValues[0]!
  const max = finiteValues[finiteValues.length - 1]!
  const grid = finiteValues.reduce<number | null>((joined, choice) => gridJoin(joined, gridOfNumber(choice)), zeroGrid)
  const value = numberValue(min, max, grid, expr, linear, null, origin)
  return withNumberCases(value, finiteValues.map(choice => ({
    value: numberValue(choice, choice, gridOfNumber(choice), String(choice), linearConstant(choice), null, origin),
    assumptions: [],
  })))
}

export function finiteNumberSet(value: NumberValue): number[] | null {
  const branches = value.cases == null ? [plainNumber(value)] : value.cases.map(branch => branch.value)
  const values: number[] = []
  for (const branch of branches) {
    if (branch.min !== branch.max || !Number.isFinite(branch.min)) return null
    values.push(branch.min)
  }
  return finiteNumberSetValues(values)
}

function finiteNumberSetValues(values: number[]) {
  return [...new Set(values.filter(Number.isFinite))].sort((left, right) => left - right)
}

export function unknownNumber(name: string): NumberValue {
  return {
    kind: 'number',
    min: Number.NEGATIVE_INFINITY,
    max: Number.POSITIVE_INFINITY,
    grid: null,
    expr: name,
    linear: linearVariable(linearNameForExpression(name)),
    computation: null,
    cases: null,
    origin: [],
  }
}

export function mergeOrigin(...items: (NumberValue | LiteralValue | string[])[]) {
  const lines: string[] = []
  for (const item of items) {
    lines.push(...(Array.isArray(item) ? item : item.origin))
  }
  return [...new Set(lines)]
}

export function plainNumber(value: NumberValue): NumberValue {
  if (value.cases == null) return value
  const plain = {...value, cases: null}
  delete plain.caseSource
  return plain
}

export function numberBranches(value: NumberValue): NumberCase[] {
  return value.cases ?? [{value: plainNumber(value), assumptions: []}]
}

export function joinNumberValues(left: NumberValue, right: NumberValue): NumberValue {
  const joined = withInheritedNumberCaseSource(
    withInheritedNumberCaseLoss(mergePlainNumberValues(left, right), left, right),
    left,
    right,
  )
  if (!shouldKeepJoinedNumberCases(left, right, joined)) return joined
  return withNumberCases(joined, [...numberBranches(left), ...numberBranches(right)])
}

export function withNumberCases(value: NumberValue, cases: NumberCase[] | null): NumberValue {
  if (cases == null || cases.length === 0) return value
  const plainCases = cases.map(choice => ({value: plainNumber(choice.value), assumptions: choice.assumptions}))
  const normalized = normalizeNumberCases(plainCases)
  if (normalized.length === 1 && sameNumberShape(value, normalized[0]!.value) && normalized[0]!.assumptions.length === 0) return value
  if (normalized.length > maxNumberCases) {
    return {
      ...value,
      cases: null,
      caseLoss: {kind: 'limit', count: normalized.length, limit: maxNumberCases},
    }
  }
  return {...value, cases: normalized}
}

export function withNumberCaseLoss(
  value: NumberValue,
  loss: NumberCaseLoss,
): NumberValue {
  return value.caseLoss == null ? {...value, caseLoss: loss} : value
}

export function withNumberCaseSource(
  value: NumberValue,
  source: NumberCaseSource,
): NumberValue {
  return value.caseSource == null ? {...value, caseSource: source} : value
}

export function withInheritedNumberCaseLoss(
  value: NumberValue,
  ...sources: NumberValue[]
): NumberValue {
  const loss = sources.find(source => source.caseLoss != null)?.caseLoss
  return loss == null || value.caseLoss != null
    ? value
    : {...value, caseLoss: loss}
}

export function withInheritedNumberCaseSource(
  value: NumberValue,
  ...sources: NumberValue[]
): NumberValue {
  const source = sources.find(item => item.caseSource != null)?.caseSource
  return source == null || value.caseSource != null
    ? value
    : {...value, caseSource: source}
}

export function withCombinedNumberCaseInfo(
  value: NumberValue,
  left: NumberValue,
  right: NumberValue,
): NumberValue {
  const loss = numberCaseCombinationLoss(left, right)
  const withLoss = loss == null ? value : withNumberCaseLoss(value, loss)
  if (withLoss.caseLoss != null) return withLoss
  return withInheritedNumberCaseSource(withLoss, left, right)
}

export function numberCaseCombinationLoss(
  left: NumberValue,
  right: NumberValue,
): NumberCaseLoss | null {
  const inherited = left.caseLoss ?? right.caseLoss
  if (inherited != null) return inherited
  const leftHasAlternatives = left.cases != null && left.cases.length > 1
  const rightHasAlternatives = right.cases != null && right.cases.length > 1
  const uncertainSource = left.caseSource ?? right.caseSource
  return leftHasAlternatives && rightHasAlternatives && uncertainSource != null
    ? {kind: 'branch', condition: uncertainSource.condition}
    : null
}

function normalizeNumberCases(cases: NumberCase[]): NumberCase[] {
  if (cases.some(choice => choice.assumptions.length > 0)) return cases
  const sorted = [...cases].sort((left, right) => left.value.min - right.value.min || left.value.max - right.value.max)
  const result: NumberCase[] = []
  for (const item of sorted) {
    const previous = result.at(-1)
    if (previous == null || !numberCasesCanMerge(previous.value, item.value)) {
      result.push(item)
      continue
    }
    result[result.length - 1] = {value: mergeNumberCaseValues(previous.value, item.value), assumptions: []}
  }
  return result
}

function numberCasesCanMerge(left: NumberValue, right: NumberValue) {
  if (numberValueContains(left, right) || numberValueContains(right, left)) return true
  if (integerValued(left) !== integerValued(right)) return false
  return integerValued(left) ? left.max + 1 >= right.min : left.max >= right.min
}

function numberValueContains(container: NumberValue, item: NumberValue) {
  if (container.min > item.min || container.max < item.max) return false
  // NaN is a runtime value too: a NaN-excluding container cannot stand in
  // for an item that admits it.
  if (possiblyNaN(item) && !possiblyNaN(container)) return false
  return !integerValued(container) || integerValued(item)
}

function mergeNumberCaseValues(left: NumberValue, right: NumberValue): NumberValue {
  return mergePlainNumberValues(left, right)
}

function mergePlainNumberValues(left: NumberValue, right: NumberValue): NumberValue {
  const merged = numberValue(
    Math.min(left.min, right.min),
    Math.max(left.max, right.max),
    gridJoin(left.grid, right.grid),
    left.expr != null && left.expr === right.expr ? left.expr : null,
    left.linear != null && right.linear != null && sameLinear(left.linear, right.linear) ? left.linear : null,
    null,
    mergeOrigin(left, right),
    mergeNumberComputation(left.computation, right.computation),
  )
  return !possiblyNaN(left) && !possiblyNaN(right) && possiblyNaN(merged)
    ? {...merged, neverNaN: true}
    : merged
}

function sameNumberShape(left: NumberValue, right: NumberValue) {
  return left.min === right.min
    && left.max === right.max
    && left.grid === right.grid
    && possiblyNaN(left) === possiblyNaN(right)
    && (left.expr ?? null) === (right.expr ?? null)
    && ((left.linear == null && right.linear == null) || (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)))
    && sameNumberComputation(left.computation, right.computation)
    && sameNumberCaseSource(left.caseSource, right.caseSource)
    && sameNumberCaseLoss(left.caseLoss, right.caseLoss)
}

function sameNumberCaseSource(left: NumberCaseSource | undefined, right: NumberCaseSource | undefined) {
  if (left == null || right == null) return left == null && right == null
  return left.condition === right.condition
}

function sameNumberCaseLoss(left: NumberCaseLoss | undefined, right: NumberCaseLoss | undefined) {
  if (left == null || right == null) return left == null && right == null
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'limit':
      return right.kind === 'limit' && left.count === right.count && left.limit === right.limit
    case 'branch':
      return right.kind === 'branch' && left.condition === right.condition
  }
}

export function sameNumberComputation(left: NumberComputation | null, right: NumberComputation | null): boolean {
  if (left === right) return true
  if (left == null || right == null || left.kind !== right.kind || left.op !== right.op) return false
  if (left.kind === 'unary' && right.kind === 'unary') return sameComputationOperand(left.operand, right.operand)
  if (left.kind === 'binary' && right.kind === 'binary') {
    if (sameComputationOperand(left.left, right.left) && sameComputationOperand(left.right, right.right)) return true
    return computationIsCommutative(left.op)
      && sameComputationOperand(left.left, right.right)
      && sameComputationOperand(left.right, right.left)
  }
  return false
}

export function sameComputationOperand(left: NumberValue, right: NumberValue): boolean {
  if (left === right) return true
  if (left.computation != null || right.computation != null) {
    return sameNumberComputation(left.computation, right.computation)
  }
  if (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)) return true
  return false
}

function mergeNumberComputation(
  left: NumberComputation | null,
  right: NumberComputation | null,
): NumberComputation | null {
  if (left === right) return left
  if (left == null || right == null || left.kind !== right.kind || left.op !== right.op) return null
  if (left.kind === 'unary' && right.kind === 'unary') {
    const operand = mergeComputationOperand(left.operand, right.operand)
    return operand == null ? null : {kind: 'unary', op: left.op, operand}
  }
  if (left.kind === 'binary' && right.kind === 'binary') {
    const direct = mergeBinaryComputationOperands(left, right, false)
    if (direct != null) return {kind: 'binary', op: left.op, ...direct}
    if (!computationIsCommutative(left.op)) return null
    const swapped = mergeBinaryComputationOperands(left, right, true)
    return swapped == null ? null : {kind: 'binary', op: left.op, ...swapped}
  }
  return null
}

function mergeBinaryComputationOperands(
  left: Extract<NumberComputation, {kind: 'binary'}>,
  right: Extract<NumberComputation, {kind: 'binary'}>,
  swapped: boolean,
): {left: NumberValue; right: NumberValue} | null {
  const mergedLeft = mergeComputationOperand(left.left, swapped ? right.right : right.left)
  if (mergedLeft == null) return null
  const mergedRight = mergeComputationOperand(left.right, swapped ? right.left : right.right)
  return mergedRight == null ? null : {left: mergedLeft, right: mergedRight}
}

function mergeComputationOperand(left: NumberValue, right: NumberValue): NumberValue | null {
  return sameComputationOperand(left, right) ? mergePlainNumberValues(left, right) : null
}

function computationIsCommutative(op: Extract<NumberComputation, {kind: 'binary'}>['op']) {
  return op === '+' || op === '*'
}

export function binaryNumberComputation(
  op: Extract<NumberComputation, {kind: 'binary'}>['op'],
  left: NumberValue,
  right: NumberValue,
): NumberComputation {
  return {kind: 'binary', op, left: plainNumber(left), right: plainNumber(right)}
}

export function unaryNumberComputation(
  op: Extract<NumberComputation, {kind: 'unary'}>['op'],
  operand: NumberValue,
): NumberComputation {
  return {kind: 'unary', op, operand: plainNumber(operand)}
}

export function numberWithComputation(value: NumberValue, computation: NumberComputation): NumberValue {
  return {...value, computation}
}

export function numberWithBounds(
  value: NumberValue,
  min: number,
  max: number,
  grid = value.grid,
  cases = value.cases,
): NumberValue {
  const bounded = withInheritedNumberCaseSource(
    withInheritedNumberCaseLoss(
      numberValue(min, max, grid, value.expr, value.linear, cases, value.origin, value.computation),
      value,
    ),
    value,
  )
  return value.neverNaN === true
    && bounded.min === Number.NEGATIVE_INFINITY
    && bounded.max === Number.POSITIVE_INFINITY
    ? {...bounded, neverNaN: true}
    : bounded
}

function shouldKeepJoinedNumberCases(left: NumberValue, right: NumberValue, joined: NumberValue) {
  if (left.cases != null || right.cases != null) return true
  const sameRange = left.min === right.min && left.max === right.max && left.grid === right.grid
  const sameExpr = (left.expr ?? null) === (right.expr ?? null)
  const sameLinearity = (left.linear == null && right.linear == null)
    || (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear))
  const sameComputation = sameNumberComputation(left.computation, right.computation)
  if (sameRange && sameExpr && sameLinearity && sameComputation) return false
  return isUsefulNumberCase(left) && isUsefulNumberCase(right) && isUsefulNumberCase(joined)
}

function isUsefulNumberCase(value: NumberValue) {
  return value.expr != null
    || value.linear != null
    || value.min !== Number.NEGATIVE_INFINITY
    || value.max !== Number.POSITIVE_INFINITY
}

// Adding a pinned zero returns the other operand under JS == (only the sign
// of -0 + 0 changes, which == cannot see), so the operand's identity, grid,
// and hull all survive.
function zeroIdentity(other: NumberValue, zero: NumberValue, expr: string | null, origin: string[]): NumberValue | null {
  if (zero.min !== 0 || zero.max !== 0) return null
  return neverNaNResult(numberValue(other.min, other.max, other.grid, expr, other.linear, null, origin), !possiblyNaN(other))
}

export function addNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const expr = binaryExpr(left, '+', right)
  const origin = mergeOrigin(left, right)
  const folded = foldBinary(left, right, (a, b) => a + b, expr, origin)
    ?? zeroIdentity(left, right, expr, origin)
    ?? zeroIdentity(right, left, expr, origin)
  if (folded != null) return folded
  const grid = gridJoin(left.grid, right.grid)
  const linear = sumIsExact(left, right, grid) ? linearAdd(left.linear, right.linear) : opaqueLinear(expr)
  // Addition is NaN only from opposite infinities (or an operand already NaN).
  const noNaN = !possiblyNaN(left) && !possiblyNaN(right)
    && !(left.max === Number.POSITIVE_INFINITY && right.min === Number.NEGATIVE_INFINITY)
    && !(left.min === Number.NEGATIVE_INFINITY && right.max === Number.POSITIVE_INFINITY)
  return neverNaNResult(numberValue(left.min + right.min, left.max + right.max, grid, expr, linear, null, origin), noNaN)
}

export function subtractNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const expr = binaryExpr(left, '-', right)
  const origin = mergeOrigin(left, right)
  const folded = foldBinary(left, right, (a, b) => a - b, expr, origin)
    ?? zeroIdentity(left, right, expr, origin)
  if (folded != null) return folded
  // x - x is exactly +0 for any finite x; the same atom names the same double
  // within one evaluation.
  if (left.linear != null && right.linear != null && sameLinear(left.linear, right.linear)
    && Number.isFinite(left.min) && Number.isFinite(left.max)) {
    return numberValue(0, 0, zeroGrid, expr, linearConstant(0), null, origin)
  }
  const grid = gridJoin(left.grid, right.grid)
  const linear = sumIsExact(left, right, grid) ? linearSubtract(left.linear, right.linear) : opaqueLinear(expr)
  // Subtraction is NaN only from same-side infinities (or an operand NaN).
  const noNaN = !possiblyNaN(left) && !possiblyNaN(right)
    && !(left.max === Number.POSITIVE_INFINITY && right.max === Number.POSITIVE_INFINITY)
    && !(left.min === Number.NEGATIVE_INFINITY && right.min === Number.NEGATIVE_INFINITY)
  return neverNaNResult(numberValue(left.min - right.max, left.max - right.min, grid, expr, linear, null, origin), noNaN)
}

// Scaling by one pinned double keeps the algebraic form only when the op is
// provably exact: an upward power of two that cannot overflow, a downward one
// the operand's grid survives, or a general constant whose products stay in
// the operand-times-constant grid window.
function scaledLinear(other: NumberValue, constant: number, resultFinite: boolean): LinearExpr | null {
  if (other.linear == null || constant === 0 || !Number.isFinite(constant)) return null
  const constantGrid = gridOfNumber(constant)!
  const constantRational = rationalFromNumber(constant)!
  if (powerOfTwoMagnitude(constant)) {
    const exact = constantGrid >= 0
      ? resultFinite
      : other.grid != null && other.grid + constantGrid >= -1074
    return exact ? linearScaleExact(other.linear, constantRational) : null
  }
  if (other.grid == null || !resultFinite) return null
  const magnitude = maxAbsRational(other)
  if (magnitude == null) return null
  const product = rationalMultiply(magnitude, rationalFromNumber(Math.abs(constant))!)
  return withinGridWindow(product, other.grid + constantGrid) ? linearScaleExact(other.linear, constantRational) : null
}

export function multiplyNumbers(left: NumberValue, right: NumberValue): NumberValue {
  const expr = binaryExpr(left, '*', right)
  const origin = mergeOrigin(left, right)
  const folded = foldBinary(left, right, (a, b) => a * b, expr, origin)
  if (folded != null) return folded
  // 0 * x is 0 only for finite x; an unbounded hull admits Infinity, whose
  // product is NaN.
  for (const [zero, other] of [[left, right], [right, left]] as const) {
    if (zero.min === 0 && zero.max === 0) {
      return Number.isFinite(other.min) && Number.isFinite(other.max)
        ? numberValue(0, 0, zeroGrid, expr, linearConstant(0), null, origin)
        : numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, expr, opaqueLinear(expr), null, origin)
    }
  }
  // A range touching zero times a range touching infinity admits 0 * Infinity
  // = NaN; the hull must widen fully so the NaN exclusion sees it.
  if ((touchesZero(left) && touchesInfinity(right)) || (touchesZero(right) && touchesInfinity(left))) {
    return numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, expr, opaqueLinear(expr), null, origin)
  }
  const products = nonNanExtrema([
    left.min * right.min,
    left.min * right.max,
    left.max * right.min,
    left.max * right.max,
  ])
  const grid = left.grid == null || right.grid == null ? null : left.grid + right.grid
  const resultFinite = Number.isFinite(products.min) && Number.isFinite(products.max)
  const linear = (left.min === left.max ? scaledLinear(right, left.min, resultFinite) : null)
    ?? (right.min === right.max ? scaledLinear(left, right.min, resultFinite) : null)
    ?? opaqueLinear(expr)
  // The 0 * Infinity widenings returned above, so only an operand NaN remains.
  const noNaN = !possiblyNaN(left) && !possiblyNaN(right)
  return neverNaNResult(numberValue(products.min, products.max, grid, expr, linear, null, origin), noNaN)
}

function touchesZero(value: NumberValue): boolean {
  return value.min <= 0 && value.max >= 0
}

function touchesInfinity(value: NumberValue): boolean {
  return value.min === Number.NEGATIVE_INFINITY || value.max === Number.POSITIVE_INFINITY
}

export function divideNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 && right.max >= 0) return unknownValue('Division by a range containing zero is unsupported')
  const expr = binaryExpr(left, '/', right)
  const origin = mergeOrigin(left, right)
  const folded = foldBinary(left, right, (a, b) => a / b, expr, origin)
  if (folded != null) return folded
  // An infinite dividend over an infinite divisor admits Infinity / Infinity
  // = NaN; widen fully so the NaN exclusion sees it.
  if (touchesInfinity(left) && touchesInfinity(right)) {
    return numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, expr, opaqueLinear(expr), null, origin)
  }
  const quotients = nonNanExtrema([
    left.min / right.min,
    left.min / right.max,
    left.max / right.min,
    left.max / right.max,
  ])
  // Division by a pinned power of two is multiplication by its exact
  // reciprocal; any other divisor leaves the dyadic grid, so neither the
  // algebraic form nor a grid survives.
  let grid: number | null = null
  let linear: LinearExpr | null = null
  if (right.min === right.max && powerOfTwoMagnitude(right.min)) {
    const divisorGrid = gridOfNumber(right.min)!
    if (left.grid != null) grid = left.grid - divisorGrid
    const resultFinite = Number.isFinite(quotients.min) && Number.isFinite(quotients.max)
    const exact = divisorGrid <= 0
      ? resultFinite
      : left.grid != null && left.grid - divisorGrid >= -1074
    if (exact && left.linear != null) {
      linear = linearScaleExact(left.linear, rationalDivide(rationalOne, rationalFromNumber(right.min)!)!)
    }
  }
  // The divisor excludes zero and the Infinity / Infinity widening returned
  // above, so only an operand NaN remains.
  const noNaN = !possiblyNaN(left) && !possiblyNaN(right)
  return neverNaNResult(numberValue(quotients.min, quotients.max, grid, expr, linear ?? opaqueLinear(expr), null, origin), noNaN)
}

// % never rounds: the exact remainder is always representable (verified
// against exact rationals over random and adversarial doubles), so the
// operands' common grid survives.
export function moduloNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min <= 0 || left.min < 0) return unknownValue('Modulo is only supported for non-negative values and positive divisors')
  const expr = binaryExpr(left, '%', right)
  const linear = expr == null ? null : linearVariable(linearNameForExpression(expr))
  // An infinite dividend gives NaN; widen fully so the NaN exclusion sees it.
  if (left.max === Number.POSITIVE_INFINITY) {
    return numberValue(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, null, expr, linear, null, mergeOrigin(left, right))
  }
  const bothInteger = integerValued(left) && integerValued(right)
  const max = bothInteger ? Math.max(0, Math.ceil(right.max) - 1) : right.max
  return numberValue(0, max, gridJoin(left.grid, right.grid), expr, linear, null, mergeOrigin(left, right))
}

// Unary minus is a sign-bit flip: exact for every double, grid preserved.
export function negateNumber(value: NumberValue, expr: string | null): NumberValue {
  const plain = withInheritedNumberCaseSource(
    withInheritedNumberCaseLoss(neverNaNResult(
      numberValue(-value.max, -value.min, value.grid, expr, linearScale(value.linear, -1), null, value.origin),
      !possiblyNaN(value),
    ), value),
    value,
  )
  if (value.cases == null) return plain
  return withNumberCases(plain, value.cases.map(branch => ({
    value: numberValue(
      -branch.value.max,
      -branch.value.min,
      branch.value.grid,
      expr,
      linearScale(branch.value.linear, -1),
      null,
      branch.value.origin,
    ),
    assumptions: branch.assumptions,
  })))
}

export function nonNanExtrema(values: number[], fallbackMin = Number.NEGATIVE_INFINITY, fallbackMax = Number.POSITIVE_INFINITY) {
  const cleanValues = values.filter(value => !Number.isNaN(value))
  if (cleanValues.length === 0) return {min: fallbackMin, max: fallbackMax}
  return {min: Math.min(...cleanValues), max: Math.max(...cleanValues)}
}

// ** is implementation-approximated per ECMA (no error bound, engines may
// differ), so no grid claim survives it; the endpoint hulls keep the existing
// host-monotonicity assumption.
export function powerNumbers(left: NumberValue, right: NumberValue): Value {
  if (right.min !== right.max) return unknownValue('Non-constant exponent is unsupported')
  if (right.min === 2 && left.min >= 0) return numberValue(left.min ** 2, left.max ** 2, null, binaryExpr(left, '**', right), null, null, mergeOrigin(left, right))
  if (left.min === left.max) return numberValue(left.min ** right.min, left.min ** right.min, null, binaryExpr(left, '**', right), null, null, mergeOrigin(left, right))
  return unknownValue('Only square of non-negative ranges is supported')
}

export function binaryExpr(left: NumberValue, op: string, right: NumberValue) {
  if (left.expr == null || right.expr == null) return null
  return `(${left.expr} ${op} ${right.expr})`
}

export function callExpr(name: string, values: NumberValue[]) {
  const parts: string[] = []
  for (const value of values) {
    if (value.expr == null) return null
    parts.push(value.expr)
  }
  return `${name}(${parts.join(', ')})`
}

function unknownValue(reason: string): UnknownValue {
  return {kind: 'unknown', reason}
}
