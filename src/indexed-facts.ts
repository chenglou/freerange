import {
  joinValues,
  numberBranches,
  numberValue,
  unknown,
  unknownNumber,
  valueWithAssumptions,
  withNumberCases,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type ObjectValue,
  type SequenceExpression,
  type SequenceTerm,
  type Value,
} from './domain.ts'
import {linearConstant} from './linear.ts'
import {comparisonConstraint, proveComparison} from './proof.ts'

export function elementValueForIndexCases(target: ArrayValue, index: NumberValue): Value | null {
  if (target.elements == null || index.cases == null) return null
  let value: Value | null = null
  for (const indexCase of numberBranches(index)) {
    const slot = exactFiniteArrayIndex(indexCase.value, target.elements.length)
    if (slot == null) return null
    const element = target.elements[slot] ?? target.element ?? unknown('Array element values are not tracked')
    const elementCase = valueWithAssumptions(element, indexCase.assumptions)
    value = value == null ? elementCase : joinValues(value, elementCase)
  }
  return value
}

export function exactFiniteArrayIndex(index: NumberValue, length: number): number | null {
  if (!index.isInteger || index.min !== index.max) return null
  const slot = index.min
  if (!Number.isInteger(slot) || slot < 0 || slot >= length) return null
  return slot
}

export function adjacentElementAccessFacts(
  target: ArrayValue,
  index: NumberValue,
  sourceName: string,
  indexText: string,
  accessExpr: string,
  assumptions: LinearConstraint[],
): LinearConstraint[] {
  const summary = target.summary
  if (summary == null || summary.relations.length === 0) return []
  const zero = numberValue(0, 0, true, '0', linearConstant(0))
  const hasPrevious = proveComparison(index, '>', zero, assumptions)
  if (hasPrevious.status !== 'pass') return []

  const previousAccessExpr = `${sourceName}[${indexText} - 1]`
  const facts: LinearConstraint[] = []
  for (const relation of summary.relations) {
    if (relation.left.item !== 'next') continue
    const leftExpr = sequenceTermExpr(accessExpr, previousAccessExpr, relation.left)
    const rightExpr = sequenceExpressionExpr(accessExpr, previousAccessExpr, relation.right)
    const fact = comparisonConstraint(unknownNumber(leftExpr), relation.op, unknownNumber(rightExpr), undefined, 'code')
    if (fact != null) facts.push(fact)
  }
  return facts
}

export function valueWithRebasedElementPath(value: Value, sourceElementExpr: string, accessExpr: string): Value {
  if (value.kind === 'number') return numberWithRebasedElementPath(value, sourceElementExpr, accessExpr)
  if (value.kind === 'object') return objectWithRebasedElementPath(value, sourceElementExpr, accessExpr)
  if (value.kind === 'array') {
    return {
      ...value,
      length: numberWithRebasedElementPath(value.length, sourceElementExpr, accessExpr),
      elements: value.elements == null ? null : value.elements.map(element => valueWithRebasedElementPath(element, sourceElementExpr, accessExpr)),
      element: value.element == null ? null : valueWithRebasedElementPath(value.element, sourceElementExpr, accessExpr),
      expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr),
    }
  }
  if (value.kind === 'nullable') {
    return {...value, present: valueWithRebasedElementPath(value.present, sourceElementExpr, accessExpr), expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
  }
  if (value.kind === 'null') return {...value, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
  return value
}

function objectWithRebasedElementPath(value: ObjectValue, sourceElementExpr: string, accessExpr: string): ObjectValue {
  const props = new Map<string, Value>()
  for (const [name, prop] of value.props) props.set(name, valueWithRebasedElementPath(prop, sourceElementExpr, accessExpr))
  return {...value, props, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
}

function numberWithRebasedElementPath(value: NumberValue, sourceElementExpr: string, accessExpr: string): NumberValue {
  const expr = rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)
  const rebased = numberValue(
    value.min,
    value.max,
    value.isInteger,
    expr,
    expr === value.expr ? value.linear : null,
    null,
    value.provenance,
  )
  if (value.cases == null) return rebased
  return withNumberCases(rebased, value.cases.map(branch => ({
    value: numberWithRebasedElementPath(branch.value, sourceElementExpr, accessExpr),
    assumptions: branch.assumptions,
  })))
}

function rebaseElementExpr(expr: string | null, sourceElementExpr: string, accessExpr: string) {
  if (expr == null) return null
  if (expr === sourceElementExpr) return accessExpr
  if (expr.startsWith(`${sourceElementExpr}.`)) return `${accessExpr}${expr.slice(sourceElementExpr.length)}`
  return expr
}

function sequenceExpressionExpr(accessExpr: string, previousAccessExpr: string, expression: SequenceExpression): string {
  const parts = expression.terms.map(term => sequenceTermExpr(accessExpr, previousAccessExpr, term))
  parts.push(...expression.addends)
  if (parts.length === 0) return '0'
  return parts.join(' + ')
}

function sequenceTermExpr(accessExpr: string, previousAccessExpr: string, term: SequenceTerm): string {
  const base = term.item === 'next' ? accessExpr : previousAccessExpr
  return term.path.length === 0 ? base : `${base}.${term.path.join('.')}`
}
