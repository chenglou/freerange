import {
  addNumbers,
  numberValue,
  unknownNumber,
  withNumberCases,
  type ArrayValue,
  type LinearConstraint,
  type NumberValue,
  type ObjectValue,
  type SequenceExpression,
  type SequenceRelation,
  type SequenceTerm,
  type Value,
} from './domain.ts'
import {expressionKeyFromText, linearConstant, type LinearExpr} from './linear.ts'
import {comparisonConstraint, proveComparison} from './proof.ts'

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
  const one = numberValue(1, 1, true, '1', linearConstant(1))
  const facts: LinearConstraint[] = []

  const hasPrevious = proveComparison(index, '>', zero, assumptions)
  if (hasPrevious.status === 'pass') {
    for (const previousAccessExpr of neighborAccessExprs(sourceName, index, indexText, -1)) {
      facts.push(...instantiateAdjacentFacts(accessExpr, previousAccessExpr, summary.relations))
    }
  }

  const nextIndex = addNumbers(index, one)
  const hasNext = proveComparison(nextIndex, '<', target.length, assumptions)
  if (hasNext.status === 'pass') {
    for (const nextAccessExpr of neighborAccessExprs(sourceName, index, indexText, 1)) {
      facts.push(...instantiateAdjacentFacts(nextAccessExpr, accessExpr, summary.relations))
    }
  }

  return dedupeFacts(facts)
}

function instantiateAdjacentFacts(nextAccessExpr: string, previousAccessExpr: string, relations: SequenceRelation[]): LinearConstraint[] {
  const facts: LinearConstraint[] = []
  for (const relation of relations) {
    if (relation.left.item !== 'next') continue
    const leftExpr = sequenceTermExpr(nextAccessExpr, previousAccessExpr, relation.left)
    const rightExpr = sequenceExpressionExpr(nextAccessExpr, previousAccessExpr, relation.right)
    const fact = comparisonConstraint(unknownNumber(leftExpr), relation.op, unknownNumber(rightExpr), undefined, 'code')
    if (fact != null) facts.push(fact)
  }
  return facts
}

function neighborAccessExprs(sourceName: string, index: NumberValue, indexText: string, offset: -1 | 1): string[] {
  const canonical = shiftedLinearIndexText(index.linear, offset)
  const text = canonical ?? `${indexText} ${offset < 0 ? '-' : '+'} 1`
  return [`${sourceName}[${text}]`]
}

function shiftedLinearIndexText(linear: LinearExpr | null, offset: -1 | 1): string | null {
  if (linear == null || linear.terms.size !== 1) return null
  const term = [...linear.terms.entries()][0]
  if (term == null) return null
  const [name, coefficient] = term
  if (coefficient !== 1) return null
  const constant = linear.constant + offset
  if (!Number.isInteger(constant)) return null
  if (constant === 0) return name
  return constant > 0 ? `${name} + ${constant}` : `${name} - ${Math.abs(constant)}`
}

function dedupeFacts(facts: LinearConstraint[]): LinearConstraint[] {
  const seen = new Set<string>()
  const result: LinearConstraint[] = []
  for (const fact of facts) {
    const key = `${expressionFactKey(fact.leftExpr)}:${fact.op}:${expressionFactKey(fact.rightExpr)}:${fact.text ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(fact)
  }
  return result
}

function expressionFactKey(expression: string | undefined) {
  return expression == null ? '?' : expressionKeyFromText(expression)
}

export function valueWithRebasedElementPath(value: Value, sourceElementExpr: string, accessExpr: string): Value {
  if (value.kind === 'number') return numberWithRebasedElementPath(value, sourceElementExpr, accessExpr)
  if (value.kind === 'literal') return {...value, expr: rebaseElementExpr(value.expr, sourceElementExpr, accessExpr)}
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
    value.origin,
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
